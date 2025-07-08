import express from 'express';
import cors from 'cors';
import { MercadoPagoConfig, Preference, Payment } from 'mercadopago';
import { MongoClient } from 'mongodb';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';

const app = express();
app.use(cors({
  origin: ['https://ederamorimth.github.io', 'http://localhost:3000', 'http://localhost:5173'],
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type']
}));
app.use(express.json({ limit: '10mb' }));

// Configura o MercadoPago
const mp = new MercadoPagoConfig({
  accessToken: process.env.ACCESS_TOKEN_MP
});

// Conecta ao MongoDB com retry
const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
let db;

async function connectDB() {
  const maxRetries = 5;
  let retries = 0;
  while (retries < maxRetries) {
    try {
      await client.connect();
      db = client.db('numeros-instantaneo');
      console.log('Conectado ao MongoDB!');
      return;
    } catch (error) {
      console.error(`Erro ao conectar ao MongoDB (tentativa ${retries + 1}):`, error.message);
      retries++;
      if (retries === maxRetries) {
        console.error('Falha ao conectar ao MongoDB após várias tentativas.');
        process.exit(1);
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
}
connectDB();

// Função para limpar reservas expiradas (5 minutos)
async function clearExpiredReservations() {
  try {
    if (!db) throw new Error('MongoDB não conectado');
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    const result = await db.collection('purchases').deleteMany({
      status: 'reserved',
      timestamp: { $lt: fiveMinutesAgo }
    });
    if (result.deletedCount > 0) {
      console.log(`[${new Date().toISOString()}] ${result.deletedCount} reservas expiradas removidas.`);
    }
  } catch (error) {
    console.error('Erro ao limpar reservas expiradas:', error.message);
  }
}

setInterval(clearExpiredReservations, 5 * 60 * 1000);

// Endpoint para números disponíveis
app.get('/available_numbers', async (req, res) => {
  const requestId = uuidv4();
  console.log(`[${new Date().toISOString()}] [${requestId}] Consultando números disponíveis...`);
  try {
    if (!db) throw new Error('MongoDB não conectado');
    const purchases = await db.collection('purchases').find().toArray();
    const soldOrReservedNumbers = purchases.flatMap(p => p.numbers || []);
    
    // Gerar todos os números de 0001 a 0900
    const allPossibleNumbers = Array.from({ length: 900 }, (_, i) => String(i + 1).padStart(4, '0'));
    
    // Filtrar números disponíveis (excluindo pagos ou reservados)
    let availableNumbers = allPossibleNumbers.filter(num => !soldOrReservedNumbers.includes(num));
    
    // Limitar a 264 números disponíveis (300 totais - 36 pagos)
    availableNumbers = availableNumbers.slice(0, 264);
    
    console.log(`[${new Date().toISOString()}] [${requestId}] Números disponíveis: ${availableNumbers.length}`);
    res.json(availableNumbers);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] [${requestId}] Erro ao buscar números disponíveis:`, error.message);
    res.status(500).json({ error: 'Erro ao buscar números disponíveis', details: error.message });
  }
});

// Endpoint para progresso
app.get('/progress', async (req, res) => {
  const requestId = uuidv4();
  console.log(`[${new Date().toISOString()}] [${requestId}] Calculando progresso...`);
  try {
    const totalNumbers = 300; // Total de números na rifa
    const purchases = await db.collection('purchases').find().toArray();
    const soldNumbers = purchases.filter(p => p.status === 'sold' || p.status === 'approved').flatMap(p => p.numbers || []).length;
    const progress = (soldNumbers / totalNumbers) * 100;
    res.json({ progress: progress.toFixed(2) });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] [${requestId}] Erro ao calcular progresso:`, error.message);
    res.status(500).json({ error: 'Erro ao calcular progresso' });
  }
});

// Endpoint para verificar total de números disponíveis
app.get('/total_available', async (req, res) => {
  const requestId = uuidv4();
  console.log(`[${new Date().toISOString()}] [${requestId}] Verificando total de números disponíveis...`);
  try {
    if (!db) throw new Error('MongoDB não conectado');
    const purchases = await db.collection('purchases').find().toArray();
    const soldOrReservedNumbers = purchases.flatMap(p => p.numbers || []);
    const allPossibleNumbers = Array.from({ length: 900 }, (_, i) => String(i + 1).padStart(4, '0'));
    const availableNumbers = allPossibleNumbers.filter(num => !soldOrReservedNumbers.includes(num)).slice(0, 264);
    const totalAvailable = availableNumbers.length;
    const totalSold = soldOrReservedNumbers.filter(num => purchases.find(p => p.numbers.includes(num) && (p.status === 'sold' || p.status === 'approved'))).length;
    res.json({ totalAvailable, totalSold, totalRaffle: 300 });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] [${requestId}] Erro ao verificar total:`, error.message);
    res.status(500).json({ error: 'Erro ao verificar total', details: error.message });
  }
});

// Demais endpoints (inalterados)
app.get('/test_mp', async (req, res) => {
  try {
    const preference = new Preference(mp);
    res.json({ status: 'Mercado Pago SDK initialized successfully' });
  } catch (error) {
    console.error('Mercado Pago test error:', error);
    res.status(500).json({ error: 'Mercado Pago initialization failed', details: error.message });
  }
});

app.get('/test_db', async (req, res) => {
  try {
    await db.collection('purchases').findOne();
    res.json({ status: 'MongoDB connected successfully' });
  } catch (error) {
    console.error('MongoDB test error:', error);
    res.status(500).json({ error: 'MongoDB connection failed', details: error.message });
  }
});

app.post('/reserve_numbers', async (req, res) => {
  const requestId = uuidv4();
  console.log(`[${new Date().toISOString()}] [${requestId}] Recebendo solicitação para reservar números:`, req.body);
  try {
    const { numbers, userId } = req.body;
    if (!numbers || !Array.isArray(numbers) || numbers.length === 0 || !userId) {
      return res.status(400).json({ error: 'Números ou userId inválidos' });
    }
    const purchases = await db.collection('purchases').find().toArray();
    const soldOrReservedNumbers = purchases.flatMap(p => p.numbers || []);
    const allPossibleNumbers = Array.from({ length: 900 }, (_, i) => String(i + 1).padStart(4, '0'));
    const availableNumbers = allPossibleNumbers.filter(num => !soldOrReservedNumbers.includes(num)).slice(0, 264);
    
    // Verificar se os números solicitados estão disponíveis
    const invalidNumbers = numbers.filter(num => !availableNumbers.includes(num));
    if (invalidNumbers.length > 0) {
      return res.status(400).json({ error: `Números indisponíveis: ${invalidNumbers.join(', ')}` });
    }
    
    const insertResult = await db.collection('purchases').insertOne({
      numbers,
      userId,
      status: 'reserved',
      timestamp: new Date(),
      buyerName: '',
      buyerPhone: ''
    });
    console.log(`[${new Date().toISOString()}] [${requestId}] Números reservados: ${numbers.join(', ')} para userId: ${userId}`);
    res.json({ success: true, insertId: insertResult.insertedId });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] [${requestId}] Erro ao reservar números:`, error.message);
    res.status(500).json({ error: 'Erro ao reservar números', details: error.message });
  }
});

app.get('/purchases', async (req, res) => {
  const requestId = uuidv4();
  console.log(`[${new Date().toISOString()}] [${requestId}] Buscando compras...`);
  try {
    const purchases = await db.collection('purchases').find().toArray();
    res.json(purchases);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] [${requestId}] Erro ao buscar compras:`, error.message);
    res.status(500).json({ error: 'Erro ao buscar compras' });
  }
});

app.get('/winning_numbers', async (req, res) => {
  const requestId = uuidv4();
  console.log(`[${new Date().toISOString()}] [${requestId}] Buscando números premiados...`);
  try {
    if (!db) throw new Error('MongoDB não conectado');
    const winningPrizes = await db.collection('winning_prizes').find().toArray();
    const formattedWinners = winningPrizes.map(prize => `${prize.number}:${prize.prize}:${prize.instagram || ''}`);
    res.json(formattedWinners);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] [${requestId}] Erro ao buscar números premiados:`, error.message);
    res.status(500).json({ error: 'Erro ao buscar números premiados', details: error.message });
  }
});

app.get('/get_winners', async (req, res) => {
  const requestId = uuidv4();
  console.log(`[${new Date().toISOString()}] [${requestId}] Buscando ganhadores...`);
  try {
    if (!db) throw new Error('MongoDB não conectado');
    const winners = await db.collection('winners').find().toArray();
    res.json(winners);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] [${requestId}] Erro ao buscar ganhadores:`, error.message);
    res.status(500).json({ error: 'Erro ao buscar ganhadores', details: error.message });
  }
});

app.post('/save_winner', async (req, res) => {
  const requestId = uuidv4();
  console.log(`[${new Date().toISOString()}] [${requestId}] Salvando ganhador:`, req.body);
  try {
    const winner = req.body;
    if (!winner.number || !winner.prize) {
      return res.status(400).json({ error: 'Número ou prêmio inválidos' });
    }
    if (!db) throw new Error('MongoDB não conectado');
    const insertResult = await db.collection('winners').insertOne({
      ...winner,
      timestamp: new Date()
    });
    res.json({ success: true, insertId: insertResult.insertedId });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] [${requestId}] Erro ao salvar ganhador:`, error.message);
    res.status(500).json({ error: 'Erro ao salvar ganhador', details: error.message });
  }
});

app.post('/create_preference', async (req, res) => {
  const requestId = uuidv4();
  console.log(`[${new Date().toISOString()}] [${requestId}] Recebendo solicitação de pagamento:`, req.body);
  try {
    const { quantity, buyerName, buyerPhone, numbers, userId } = req.body;
    if (!numbers || !Array.isArray(numbers) || numbers.length === 0) {
      return res.status(400).json({ error: 'Por favor, selecione pelo menos um número' });
    }
    if (!buyerName || !buyerPhone || !userId) {
      return res.status(400).json({ error: 'Nome, telefone e userId são obrigatórios' });
    }
    if (!quantity || quantity !== numbers.length) {
      return res.status(400).json({ error: 'Quantidade inválida ou não corresponde aos números selecionados' });
    }

    const purchases = await db.collection('purchases').find().toArray();
    const soldOrReservedNumbers = purchases.flatMap(p => p.numbers || []);
    const allPossibleNumbers = Array.from({ length: 900 }, (_, i) => String(i + 1).padStart(4, '0'));
    const availableNumbers = allPossibleNumbers.filter(num => !soldOrReservedNumbers.includes(num)).slice(0, 264);
    
    // Verificar se os números solicitados estão disponíveis
    const invalidNumbers = numbers.filter(num => !availableNumbers.includes(num));
    if (invalidNumbers.length > 0) {
      return res.status(400).json({ error: `Números indisponíveis: ${invalidNumbers.join(', ')}` });
    }

    const validNumbers = await db.collection('purchases').find({
      numbers: { $in: numbers },
      status: 'reserved',
      userId
    }).toArray();

    const reservedNumbers = validNumbers.flatMap(p => p.numbers);
    const missingNumbers = numbers.filter(num => !reservedNumbers.includes(num));
    if (missingNumbers.length > 0) {
      console.error(`[${new Date().toISOString()}] [${requestId}] Números não estão reservados para o usuário ${userId}: ${missingNumbers.join(', ')}`);
      return res.status(400).json({ error: `Números não estão reservados para este usuário: ${missingNumbers.join(', ')}` });
    }

    const preference = new Preference(mp);
    const preferenceData = {
      body: {
        items: [{
          title: `Rifa - ${quantity} número(s)`,
          quantity: Number(quantity),
          unit_price: 20,
        }],
        payer: {
          name: buyerName,
          phone: { number: buyerPhone },
        },
        back_urls: {
          success: "https://ederamorimth.github.io/rifa-miguel/sucesso.html",
          failure: "https://ederamorimth.github.io/rifa-miguel/erro.html",
          pending: "https://ederamorimth.github.io/rifa-miguel/pendente.html"
        },
        auto_return: "approved",
        external_reference: JSON.stringify({ buyerName, buyerPhone, numbers, userId }),
        notification_url: "https://rifa-miguel.onrender.com/webhook"
      }
    };

    const response = await preference.create(preferenceData);
    console.log(`[${new Date().toISOString()}] [${requestId}] Preferência criada: ${response.id}`);
    res.json({ init_point: response.init_point, preference_id: response.id });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] [${requestId}] Erro ao criar preferência:`, error.message);
    res.status(500).json({ error: 'Erro ao criar preferência', details: error.message });
  }
});

app.post('/webhook', async (req, res) => {
  const requestId = uuidv4();
  console.log(`[${new Date().toISOString()}] [${requestId}] Webhook recebido:`, req.body);
  try {
    if (req.method !== 'POST') {
      return res.status(405).send('Method Not Allowed');
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
      return res.status(200).send('OK');
    }

    const payment = new Payment(mp);
    const paymentDetails = await payment.get({ id: paymentId });
    if (paymentDetails.status !== 'approved') {
      console.log(`[${new Date().toISOString()}] [${requestId}] Pagamento ${paymentId} não está aprovado. Status: ${paymentDetails.status}`);
      return res.status(200).send('OK');
    }

    let externalReference;
    try {
      externalReference = JSON.parse(paymentDetails.external_reference || '{}');
    } catch (e) {
      console.error(`[${new Date().toISOString()}] [${requestId}] Erro ao parsear external_reference:`, e);
      return res.status(400).send('Invalid external reference');
    }
    const { numbers, userId, buyerName, buyerPhone } = externalReference;

    if (!numbers || !Array.isArray(numbers) || numbers.length === 0 || !userId || !buyerName || !buyerPhone) {
      console.error(`[${new Date().toISOString()}] [${requestId}] Dados incompletos no external_reference`);
      return res.status(400).send('Dados incompletos');
    }

    if (!db) throw new Error('MongoDB não conectado');

    const existingPurchase = await db.collection('purchases').findOne({
      paymentId: paymentDetails.id,
      status: 'approved'
    });
    if (existingPurchase) {
      console.log(`[${new Date().toISOString()}] [${requestId}] Pagamento ${paymentId} já processado. Ignorando.`);
      return res.status(200).send('OK');
    }

    const reservedNumbers = await db.collection('purchases').find({
      numbers: { $in: numbers },
      status: 'reserved',
      userId
    }).toArray();

    const reservedNumbersList = reservedNumbers.flatMap(p => p.numbers);
    const missingNumbers = numbers.filter(num => !reservedNumbersList.includes(num));
    if (missingNumbers.length > 0) {
      console.error(`[${new Date().toISOString()}] [${requestId}] Números não estão reservados corretamente para o usuário ${userId}: ${missingNumbers.join(', ')}`);
      return res.status(400).send(`Números não estão reservados corretamente: ${missingNumbers.join(', ')}`);
    }

    const session = client.startSession();
    try {
      await session.withTransaction(async () => {
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

        const updatedPurchases = await db.collection('purchases').find(
          { paymentId: paymentDetails.id },
          { session }
        ).toArray();
        const updatedNumbers = updatedPurchases.flatMap(p => p.numbers);
        if (!numbers.every(num => updatedNumbers.includes(num))) {
          throw new Error('Falha ao salvar todos os números pagos');
        }

        // Verificar se o total de números vendidos não excede 300
        const totalSold = (await db.collection('purchases').find({ status: { $in: ['sold', 'approved'] } }).toArray())
          .flatMap(p => p.numbers || []).length;
        if (totalSold > 300) {
          throw new Error('Limite de 300 números na rifa excedido');
        }

        console.log(`[${new Date().toISOString()}] [${requestId}] Pagamento ${paymentId} aprovado. Números ${numbers.join(', ')} salvos para ${buyerName}.`);
      });
    } catch (error) {
      console.error(`[${new Date().toISOString()}] [${requestId}] Erro na transação:`, error);
      throw error;
    } finally {
      session.endSession();
    }
    return res.status(200).send('OK');
  } catch (error) {
    console.error(`[${new Date().toISOString()}] [${requestId}] Erro no webhook:`, error.message);
    return res.status(200).send('OK');
  }
});

app.get('/get-page-password', (req, res) => {
  const requestId = uuidv4();
  console.log(`[${new Date().toISOString()}] [${requestId}] Solicitação para obter hash da senha`);
  const password = process.env.PAGE_PASSWORD;
  if (!password) {
    console.error(`[${new Date().toISOString()}] [${requestId}] Senha não configurada no servidor`);
    return res.status(500).json({ error: 'Senha não configurada no servidor' });
  }
  const hash = crypto.createHash('sha256').update(password).digest('hex');
  res.json({ passwordHash: hash });
});

app.get('/test_payment/:id', async (req, res) => {
  const requestId = uuidv4();
  console.log(`[${new Date().toISOString()}] [${requestId}] Testando pagamento: ${req.params.id}`);
  try {
    const paymentId = req.params.id;
    const payment = new Payment(mp);
    const paymentDetails = await payment.get({ id: paymentId });
    res.json({ paymentDetails, preferenceId: paymentDetails.preference_id || 'Não encontrada' });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] [${requestId}] Erro ao testar pagamento:`, error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/test_preference/:id', async (req, res) => {
  const requestId = uuidv4();
  console.log(`[${new Date().toISOString()}] [${requestId}] Testando preferência: ${req.params.id}`);
  try {
    const preferenceId = req.params.id;
    const preference = new Preference(mp);
    const preferenceDetails = await preference.get({ id: preferenceId });
    res.json({ preferenceDetails, externalReference: preferenceDetails.external_reference || 'Não encontrada' });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] [${requestId}] Erro ao testar preferência:`, error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/', (req, res) => {
  res.send('API da Rifa está online!');
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT} em ${new Date().toISOString()}`);
});
