// Endpoint para webhook
app.post('/webhook', async (req, res) => {
  const requestId = uuidv4();
  console.log(`[${new Date().toISOString()}] [${requestId}] Webhook recebido:`, req.body);

  // Função auxiliar para enviar resposta e evitar múltiplas respostas
  const sendResponse = (status, body) => {
    if (res.headersSent) {
      console.warn(`[${new Date().toISOString()}] [${requestId}] Tentativa de enviar resposta após headers já enviados. Ignorando.`);
      return;
    }
    res.status(status).send(body);
  };

  try {
    if (req.method !== 'POST') {
      return sendResponse(405, 'Method Not Allowed');
    }

    const body = req.body;
    let paymentId = body.data?.id || body.resource?.match(/^\d+$/)?.[0] || (body.action === 'payment.updated' && body.data?.id);

    if (!paymentId && body.topic === 'merchant_order' && body.resource) {
      const merchantOrderId = body.resource.match(/\/(\d+)$/)[1];
      const payment = new Payment(mp);
      const orders = await payment.search({ filters: { merchant_order_id: merchantOrderId } });
      paymentId = orders.results?.[0]?.id;
    }

    if (!paymentId) {
      console.log(`[${new Date().toISOString()}] [${requestId}] Nenhum ID de pagamento válido encontrado`);
      return sendResponse(200, 'OK');
    }

    if (!db) {
      console.error(`[${new Date().toISOString()}] [${requestId}] MongoDB não conectado`);
      return sendResponse(500, 'MongoDB não conectado');
    }

    // Tentar adquirir um lock para o pagamento
    const lockTimeout = new Date(Date.now() - 30 * 1000); // Lock expira após 30 segundos
    const lockResult = await db.collection('purchases').updateOne(
      { paymentId: paymentId, $or: [{ status: { $exists: false } }, { status: 'processing', processingTimestamp: { $lt: lockTimeout } }] },
      { $set: { status: 'processing', processingTimestamp: new Date(), requestId } },
      { upsert: true }
    );

    if (lockResult.matchedCount === 0 && lockResult.upsertedCount === 0) {
      console.log(`[${new Date().toISOString()}] [${requestId}] Pagamento ${paymentId} já está sendo processado por outra requisição. Ignorando.`);
      return sendResponse(200, 'OK');
    }

    // Verificar se o pagamento já foi processado
    const existingPurchase = await db.collection('purchases').findOne({
      paymentId: paymentId,
      status: 'approved'
    });

    if (existingPurchase) {
      console.log(`[${new Date().toISOString()}] [${requestId}] Pagamento ${paymentId} já processado. Ignorando.`);
      await db.collection('purchases').deleteOne({ paymentId: paymentId, status: 'processing', requestId });
      return sendResponse(200, 'OK');
    }

    const payment = new Payment(mp);
    const paymentDetails = await payment.get({ id: paymentId });

    if (paymentDetails.status !== 'approved') {
      console.log(`[${new Date().toISOString()}] [${requestId}] Pagamento ${paymentId} não está aprovado. Status: ${paymentDetails.status}`);
      await db.collection('purchases').deleteOne({ paymentId: paymentId, status: 'processing', requestId });
      return sendResponse(200, 'OK');
    }

    let externalReference;
    try {
      externalReference = JSON.parse(paymentDetails.external_reference || '{}');
    } catch (e) {
      console.error(`[${new Date().toISOString()}] [${requestId}] Erro ao parsear external_reference:`, e.message);
      await db.collection('purchases').deleteOne({ paymentId: paymentId, status: 'processing', requestId });
      return sendResponse(400, 'Invalid external reference');
    }

    const { numbers, userId, buyerName, buyerPhone } = externalReference;

    if (!numbers || !Array.isArray(numbers) || numbers.length === 0 || !userId || !buyerName || !buyerPhone) {
      console.error(`[${new Date().toISOString()}] [${requestId}] Dados incompletos no external_reference`);
      await db.collection('purchases').deleteOne({ paymentId: paymentId, status: 'processing', requestId });
      return sendResponse(400, 'Dados incompletos');
    }

    const session = client.startSession();
    try {
      await session.withTransaction(async () => {
        // Verificar se todos os números estão reservados para o userId
        const reservedNumbers = await db.collection('purchases').find({
          numbers: { $in: numbers },
          status: 'reserved',
          userId
        }, { session }).toArray();

        const reservedNumbersList = reservedNumbers.flatMap(p => p.numbers);
        const missingNumbers = numbers.filter(num => !reservedNumbersList.includes(num));
        if (missingNumbers.length > 0) {
          console.error(`[${new Date().toISOString()}] [${requestId}] Números não estão reservados corretamente para o usuário ${userId}: ${missingNumbers.join(', ')}`);
          await db.collection('purchases').deleteOne({ paymentId: paymentId, status: 'processing', requestId }, { session });
          return sendResponse(400, `Números não estão reservados corretamente: ${missingNumbers.join(', ')}`);
        }

        // Verificar se o total de números vendidos não excede 300
        const totalSold = (await db.collection('purchases').find({ status: { $in: ['sold', 'approved'] } }, { session }).toArray())
          .flatMap(p => p.numbers || []).length;
        if (totalSold + numbers.length > 300) {
          console.error(`[${new Date().toISOString()}] [${requestId}] Limite de 300 números na rifa excedido`);
          await db.collection('purchases').deleteOne({ paymentId: paymentId, status: 'processing', requestId }, { session });
          return sendResponse(400, 'Limite de 300 números na rifa excedido');
        }

        // Atualizar números como aprovados
        const updateResult = await db.collection('purchases').updateMany(
          {
            numbers: { $in: numbers },
            status: 'reserved',
            userId
          },
          {
            $set: {
              status: 'approved',
              buyerName,
              buyerPhone,
              paymentId: paymentDetails.id,
              date_approved: paymentDetails.date_approved || new Date(),
              preference_id: paymentDetails.preference_id || 'Não encontrado',
              userId: null,
              timestamp: null
            }
          },
          { session }
        );

        if (updateResult.matchedCount === 0) {
          throw new Error('Nenhum documento correspondente encontrado para atualização');
        }

        // Confirmar que todos os números foram salvos
        const updatedPurchases = await db.collection('purchases').find(
          { paymentId: paymentDetails.id },
          { session }
        ).toArray();
        const updatedNumbers = updatedPurchases.flatMap(p => p.numbers);
        if (!numbers.every(num => updatedNumbers.includes(num))) {
          throw new Error('Falha ao salvar todos os números pagos');
        }

        console.log(`[${new Date().toISOString()}] [${requestId}] Pagamento ${paymentId} aprovado. Números ${numbers.join(', ')} salvos para ${buyerName}.`);
      });
    } catch (error) {
      console.error(`[${new Date().toISOString()}] [${requestId}] Erro na transação:`, error.message);
      throw error;
    } finally {
      session.endSession();
      // Limpar lock de processamento
      await db.collection('purchases').deleteOne({ paymentId: paymentId, status: 'processing', requestId });
    }

    return sendResponse(200, 'OK');
  } catch (error) {
    console.error(`[${new Date().toISOString()}] [${requestId}] Erro no webhook:`, error.message);
    // Limpar lock de processamento em caso de erro
    await db.collection('purchases').deleteOne({ paymentId: paymentId, status: 'processing', requestId });
    return sendResponse(200, 'OK');
  }
});
