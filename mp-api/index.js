import express from 'express';
import cors from 'cors';
import { MercadoPagoConfig, Preference, Payment } from 'mercadopago';
import { MongoClient } from 'mongodb';

const app = express();
app.use(cors({
  origin: 'https://ederamorimth.github.io',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type']
}));
app.use(express.json({ limit: '10mb' }));

// Configura o MercadoPago
const mp = new MercadoPagoConfig({
  accessToken: process.env.ACCESS_TOKEN_MP
});

// Conecta ao MongoDB
const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
let db;

async function connectDB() {
  try {
    await client.connect();
    db = client.db('rifa_miguel');
    console.log('Conectado ao MongoDB!');
  } catch (error) {
    console.error('Erro ao conectar ao MongoDB:', error.message);
  }
}
connectDB();

// Test endpoint to check Mercado Pago
app.get('/test_mp', async (req, res) => {
  try {
    const preference = new Preference(mp);
    res.json({ status: 'Mercado Pago SDK initialized successfully' });
  } catch (error) {
    console.error('Mercado Pago test error:', error);
    res.status(500).json({ error: 'Mercado Pago initialization failed', details: error.message });
  }
});

// Test endpoint to check MongoDB
app.get('/test_db', async (req, res) => {
  try {
    await db.collection('purchases').findOne();
    res.json({ status: 'MongoDB connected successfully' });
  } catch (error) {
    console.error('MongoDB test error:', error);
    res.status(500).json({ error: 'MongoDB connection failed', details: error.message });
  }
});

// Endpoint para verificar números disponíveis
app.get('/available_numbers', async (req, res) => {
  try {
    if (!db) throw new Error('MongoDB não conectado');
    console.log('Consultando coleção purchases...');
    const purchases = await db.collection('purchases').find().toArray();
    console.log(`Número de documentos na coleção purchases: ${purchases.length}`);
    const soldOrReservedNumbers = purchases.flatMap(p => p.numbers || []);
    console.log(`Números vendidos ou reservados encontrados: ${soldOrReservedNumbers.length}`);
    const allNumbers = Array.from({ length: 900 }, (_, i) => String(i + 1).padStart(4, '0'));
    const availableNumbers = allNumbers.filter(num => !soldOrReservedNumbers.includes(num));
    console.log(`Números disponíveis retornados: ${availableNumbers.length}`);
    if (availableNumbers.length === 0) {
      console.warn('Nenhum número disponível encontrado');
    }
    res.json(availableNumbers);
  } catch (error) {
    console.error('Erro ao buscar números disponíveis:', error.message);
    res.status(500).json({ error: 'Erro ao buscar números disponíveis', details: error.message });
  }
});

// Endpoint para calcular progresso
app.get('/progress', async (req, res) => {
  try {
    const totalNumbers = 900;
    const purchases = await db.collection('purchases').find().toArray();
    const soldNumbers = purchases.filter(p => p.status === 'sold' || p.status === 'approved').flatMap(p => p.numbers || []).length;
    const progress = (soldNumbers / totalNumbers) * 100;
    res.json({ progress: progress.toFixed(2) });
  } catch (error) {
    console.error('Erro ao calcular progresso:', error);
    res.status(500).json({ error: 'Erro ao calcular progresso' });
  }
});

// Endpoint para reservar números
app.post('/reserve_numbers', async (req, res) => {
  try {
    const { numbers, userId } = req.body;
    if (!numbers || !Array.isArray(numbers) || numbers.length === 0 || !userId) {
      return res.status(400).json({ error: 'Números ou userId inválidos' });
    }
    const purchases = await db.collection('purchases').find().toArray();
    const soldOrReservedNumbers = purchases.flatMap(p => p.numbers || []);
    const invalidNumbers = numbers.filter(num => soldOrReservedNumbers.includes(num));
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
    console.log(`[${new Date().toISOString()}] Números reservados: ${numbers.join(', ')} para userId: ${userId}`);
    res.json({ success: true, insertId: insertResult.insertedId });
  } catch (error) {
    console.error('Erro ao reservar números:', error.message);
    res.status(500).json({ error: 'Erro ao reservar números', details: error.message });
  }
});

// Endpoint para dados do sorteio
app.get('/purchases', async (req, res) => {
  try {
    const purchases = await db.collection('purchases').find().toArray();
    res.json(purchases);
  } catch (error) {
    console.error('Erro ao buscar compras:', error);
    res.status(500).json({ error: 'Erro ao buscar compras' });
  }
});

// Rota para verificar a senha
app.post('/verify_password', (req, res) => {
  try {
    const { password } = req.body;
    const correctPassword = process.env.SORTEIO_PASSWORD || 'VAIDACERTO';
    console.log('Verificando senha às:', new Date().toISOString());

    if (!password) {
      console.log('Erro: Senha não fornecida');
      return res.status(400).json({ error: 'Senha não fornecida' });
    }

    if (password === correctPassword) {
      console.log('Senha válida');
      res.json({ valid: true });
    } else {
      console.log('Senha inválida');
      res.json({ valid: false });
    }
  } catch (error) {
    console.error('Erro ao verificar senha:', error.message);
    res.status(500).json({ error: 'Erro ao verificar senha', details: error.message });
  }
});

// Test endpoint to debug request body
app.post('/test_create_preference', (req, res) => {
  console.log('Test request body:', req.body);
  res.json({ received: req.body, status: 'Test endpoint working' });
});

// Endpoint para criar preferência de pagamento
app.post('/create_preference', async (req, res) => {
  try {
    const { quantity, buyerName, buyerPhone, numbers, userId } = req.body;
    console.log('Received request body at:', new Date().toISOString(), { quantity, buyerName, buyerPhone, numbers, userId });

    // Validate inputs
    if (!numbers || !Array.isArray(numbers) || numbers.length === 0) {
      console.log('Error: Invalid or missing numbers');
      return res.status(400).json({ error: 'Por favor, selecione pelo menos um número' });
    }
    if (!buyerName || !buyerPhone || !userId) {
      console.log('Error: Missing name, phone, or userId');
      return res.status(400).json({ error: 'Nome, telefone e userId são obrigatórios' });
    }
    if (!quantity || quantity !== numbers.length) {
      console.log('Error: Invalid quantity');
      return res.status(400).json({ error: 'Quantidade inválida ou não corresponde aos números selecionados' });
    }

    console.log('Verifying reserved numbers...');
    const validNumbers = await db.collection('purchases').find({
      numbers: { $in: numbers },
      status: 'reserved',
      userId
    }).toArray();
    if (validNumbers.length !== numbers.length) {
      console.error(`[${new Date().toISOString()}] Números não estão reservados para o usuário: ${userId}`);
      return res.status(400).json({ error: 'Números não estão reservados para este usuário' });
    }

    console.log('Creating Mercado Pago preference...');
    const preference = new Preference(mp);
    const preferenceData = {
      body: {
        items: [{
          title: `Rifa - ${quantity} número(s)`,
          quantity: Number(quantity),
          unit_price: 20, // Ajustado para R$ 20 por número
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

    console.log('Preference data being sent:', JSON.stringify(preferenceData, null, 2));
    const response = await preference.create(preferenceData);
    console.log('Preference created successfully, init_point:', response.init_point, 'Preference ID:', response.id);
    res.json({ init_point: response.init_point, preference_id: response.id });
  } catch (error) {
    console.error('Error in /create_preference at:', new Date().toISOString(), error.message, 'Stack:', error.stack);
    res.status(500).json({ error: 'Erro ao criar preferência', details: error.message });
  }
});

// Endpoint para webhook
app.post('/webhook', async (req, res) => {
  try {
    console.log('Webhook received at:', new Date().toISOString(), 'Method:', req.method, 'Raw Body:', JSON.stringify(req.body, null, 2));
    if (req.method !== 'POST') {
      console.log('Method not allowed:', req.method);
      return res.status(405).send('Method Not Allowed');
    }

    const body = req.body;
    console.log('Processing POST webhook...', 'Body:', JSON.stringify(body, null, 2));
    let paymentId = null;

    // Extrair paymentId de diferentes formatos
    if (body.type === 'payment' && body.data && body.data.id) {
      paymentId = body.data.id;
    } else if (body.resource && typeof body.resource === 'string' && body.resource.match(/^\d+$/)) {
      paymentId = body.resource;
    } else if (body.action === 'payment.updated' && body.data && body.data.id) {
      paymentId = body.data.id;
    } else if (body.topic === 'merchant_order' && body.resource) {
      const merchantOrderId = body.resource.match(/\/(\d+)$/)[1];
      const payment = new Payment(mp);
      const orders = await payment.search({ filters: { merchant_order_id: merchantOrderId } });
      if (orders.results && orders.results.length > 0) {
        paymentId = orders.results[0].id;
      }
    }

    if (paymentId) {
      const payment = new Payment(mp);
      try {
        const paymentDetails = await payment.get({ id: paymentId });
        console.log('Payment details:', {
          id: paymentDetails.id,
          status: paymentDetails.status,
          preference_id: paymentDetails.preference_id || 'Não encontrado',
          external_reference: paymentDetails.external_reference || 'Não encontrado',
          transaction_amount: paymentDetails.transaction_amount || 'Não encontrado',
          date_approved: paymentDetails.date_approved || 'Não aprovado ainda'
        });

        if (paymentDetails.status === 'approved') {
          let externalReference;
          try {
            externalReference = JSON.parse(paymentDetails.external_reference || '{}');
          } catch (e) {
            console.error(`[${new Date().toISOString()}] Erro ao parsear external_reference:`, e);
            return res.sendStatus(400);
          }
          const { numbers, userId, buyerName, buyerPhone } = externalReference;

          if (!db) {
            console.error('MongoDB não conectado');
            return res.status(500).send('Erro: MongoDB não conectado');
          }

          // Verificar se os números estão reservados para o userId
          const validNumbers = await db.collection('purchases').find({
            numbers: { $in: numbers },
            status: 'reserved',
            userId
          }).toArray();

          if (validNumbers.length !== numbers.length) {
            console.error(`[${new Date().toISOString()}] Números não estão reservados para o usuário: ${userId}`);
            return res.status(400).send('Números não estão reservados para o usuário');
          }

          // Iniciar transação
          const session = client.startSession();
          try {
            await session.withTransaction(async () => {
              // Atualizar números para "vendido" e limpar userId e timestamp
              const compradorResult = await db.collection('purchases').updateMany(
                { numbers: { $in: numbers }, status: 'reserved', userId },
                { $set: { status: 'sold', userId: null, timestamp: null } },
                { session }
              );
              console.log(`[${new Date().toISOString()}] Compradores atualizados: ${compradorResult.modifiedCount}`);

              // Atualizar ou inserir compra como aprovada
              const purchaseResult = await db.collection('purchases').updateMany(
                { numbers: { $in: numbers }, status: 'reserved' },
                { $set: { status: 'approved', paymentId, date_approved: new Date() } },
                { session }
              );
              console.log(`[${new Date().toISOString()}] Compras atualizadas: ${purchaseResult.modifiedCount}`);

              // Se nenhuma compra foi atualizada, inserir uma nova
              if (purchaseResult.modifiedCount === 0) {
                const insertResult = await db.collection('purchases').insertOne({
                  buyerName,
                  buyerPhone,
                  numbers,
                  purchaseDate: new Date(),
                  paymentId: paymentDetails.id,
                  status: 'approved',
                  date_approved: paymentDetails.date_approved || new Date(),
                  preference_id: paymentDetails.preference_id || 'Não encontrado'
                }, { session });
                console.log('Nova compra inserida:', insertResult.insertedId, { buyerName, buyerPhone, numbers });
              }

              console.log(`[${new Date().toISOString()}] Pagamento ${paymentId} aprovado. Números ${numbers.join(', ')} marcados como vendido.`);
            });
          } catch (error) {
            console.error(`[${new Date().toISOString()}] Erro na transação:`, error);
            throw error;
          } finally {
            session.endSession();
          }
        } else {
          console.log(`[${new Date().toISOString()}] Pagamento ${paymentId} não está aprovado. Status: ${paymentDetails.status}`);
        }
      } catch (error) {
        console.error('Erro ao buscar payment details:', error.message);
        return res.status(200).send('OK');
      }
    } else {
      console.log('No valid payment ID found:', JSON.stringify(body, null, 2));
    }
    return res.status(200).send('OK');
  } catch (error) {
    console.error('Erro no webhook:', error.message);
    return res.status(200).send('OK');
  }
});

// Função auxiliar para buscar preference_id
async function getPreferenceIdFromPayment(paymentId) {
  try {
    const payment = new Payment(mp);
    const paymentDetails = await payment.get({ id: paymentId });
    console.log('Payment details for preference_id:', {
      paymentId,
      preference_id: paymentDetails.preference_id || 'Não encontrado',
      status: paymentDetails.status
    });
    return paymentDetails.preference_id || null;
  } catch (error) {
    console.error('Erro ao buscar preference_id:', error.message);
    return null;
  }
}

// Endpoint temporário para testar pagamento
app.get('/test_payment/:id', async (req, res) => {
  try {
    const paymentId = req.params.id;
    const payment = new Payment(mp);
    const paymentDetails = await payment.get({ id: paymentId });
    res.json({ paymentDetails, preferenceId: paymentDetails.preference_id || 'Não encontrado' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Endpoint temporário para testar preferência
app.get('/test_preference/:id', async (req, res) => {
  try {
    const preferenceId = req.params.id;
    const preference = new Preference(mp);
    const preferenceDetails = await preference.get({ id: preferenceId });
    res.json({ preferenceDetails, externalReference: preferenceDetails.external_reference || 'Não encontrado' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/', (req, res) => {
  res.send('API da Rifa está online!');
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT} at ${new Date().toISOString()}`);
});
