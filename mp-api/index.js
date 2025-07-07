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

const mp = new MercadoPagoConfig({
  accessToken: process.env.ACCESS_TOKEN_MP
});

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
      const collections = await db.listCollections().toArray();
      const collectionExists = collections.some(col => col.name === 'purchases');
      if (!collectionExists) {
        await db.createCollection('purchases');
      }
      await initializeNumbers();
      await restoreApprovedNumbers();
      return;
    } catch (error) {
      console.error(`[${new Date().toISOString()}] [${uuidv4()}] Erro ao conectar ao MongoDB (tentativa ${retries + 1}): ${error.message}`);
      retries++;
      if (retries === maxRetries) {
        process.exit(1);
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
}

async function initializeNumbers() {
  const requestId = uuidv4();
  try {
    if (!db) throw new Error('MongoDB não conectado');
    const collections = await db.listCollections().toArray();
    const availableNumbersExists = collections.some(col => col.name === 'available_numbers');
    if (!availableNumbersExists) {
      const allNumbers = Array.from({ length: 900 }, (_, i) => String(i + 1).padStart(4, '0'));
      await db.createCollection('available_numbers');
      await db.collection('available_numbers').insertOne({
        numbers: allNumbers,
        status: 'available',
        timestamp: new Date()
      });
    }
  } catch (error) {
    console.error(`[${new Date().toISOString()}] [${requestId}] Erro ao inicializar números: ${error.message}`);
  }
}

async function restoreApprovedNumbers() {
  const requestId = uuidv4();
  try {
    if (!db) throw new Error('MongoDB não conectado');
    const approvedPurchases = await db.collection('purchases').find({ status: 'approved' }).toArray();
    const approvedCount = approvedPurchases.reduce((sum, purchase) => sum + (purchase.numbers?.length || 0), 0);
    console.log(`[${new Date().toISOString()}] [${requestId}] ${approvedCount} números aprovados restaurados.`);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] [${requestId}] Erro ao restaurar números aprovados: ${error.message}`);
  }
}

async function clearExpiredReservations() {
  const requestId = uuidv4();
  try {
    if (!db) throw new Error('MongoDB não conectado');
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    const result = await db.collection('purchases').deleteMany({
      status: { $in: ['reserved', 'pending'] },
      timestamp: { $lt: fiveMinutesAgo }
    });
    if (result.deletedCount > 0) {
      console.log(`[${new Date().toISOString()}] [${requestId}] ${result.deletedCount} reservas/pendentes expirados removidos.`);
    }
  } catch (error) {
    console.error(`[${new Date().toISOString()}] [${requestId}] Erro ao limpar reservas/pendentes expirados: ${error.message}`);
  }
}

connectDB();
setInterval(clearExpiredReservations, 5 * 60 * 1000);

app.get('/test_mp', async (req, res) => {
  const requestId = uuidv4();
  try {
    const preference = new Preference(mp);
    res.json({ status: 'Mercado Pago SDK initialized successfully' });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] [${requestId}] Teste Mercado Pago falhou: ${error.message}`);
    res.status(500).json({ error: 'Mercado Pago initialization failed', details: error.message });
  }
});

app.get('/test_db', async (req, res) => {
  const requestId = uuidv4();
  try {
    await db.collection('purchases').findOne();
    res.json({ status: 'MongoDB connected successfully' });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] [${requestId}] Teste MongoDB falhou: ${error.message}`);
    res.status(500).json({ error: 'MongoDB connection failed', details: error.message });
  }
});

app.get('/available_numbers', async (req, res) => {
  const requestId = uuidv4();
  try {
    if (!db) throw new Error('MongoDB não conectado');
    const purchases = await db.collection('purchases').find({ status: 'approved' }).toArray();
    const soldNumbers = purchases.flatMap(p => p.numbers || []);
    const availableNumbersDoc = await db.collection('available_numbers').findOne({ status: 'available' });
    const allNumbers = availableNumbersDoc ? availableNumbersDoc.numbers : Array.from({ length: 900 }, (_, i) => String(i + 1).padStart(4, '0'));
    const availableNumbers = allNumbers.filter(num => !soldNumbers.includes(num));
    console.log(`[${new Date().toISOString()}] [${requestId}] Números disponíveis: ${availableNumbers.length}`);
    res.json(availableNumbers);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] [${requestId}] Erro ao buscar números disponíveis: ${error.message}`);
    res.status(500).json({ error: 'Erro ao buscar números disponíveis', details: error.message });
  }
});

app.get('/progress', async (req, res) => {
  const requestId = uuidv4();
  try {
    const totalNumbers = 900;
    const purchases = await db.collection('purchases').find({ status: 'approved' }).toArray();
    const soldNumbers = purchases.reduce((sum, p) => sum + (p.numbers?.length || 0), 0);
    const progress = (soldNumbers / totalNumbers) * 100;
    res.json({ progress: progress.toFixed(2) });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] [${requestId}] Erro ao calcular progresso: ${error.message}`);
    res.status(500).json({ error: 'Erro ao calcular progresso', details: error.message });
  }
});

app.post('/reserve_numbers', async (req, res) => {
  const requestId = uuidv4();
  try {
    const { numbers, userId } = req.body;
    if (!numbers || !Array.isArray(numbers) || numbers.length === 0 || !userId) {
      return res.status(400).json({ error: 'Números ou userId inválidos' });
    }
    const purchases = await db.collection('purchases').find({ status: 'approved' }).toArray();
    const soldNumbers = purchases.flatMap(p => p.numbers || []);
    const invalidNumbers = numbers.filter(num => soldNumbers.includes(num));
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
    console.error(`[${new Date().toISOString()}] [${requestId}] Erro ao reservar números: ${error.message}`);
    res.status(500).json({ error: 'Erro ao reservar números', details: error.message });
  }
});

app.get('/purchases', async (req, res) => {
  const requestId = uuidv4();
  try {
    const purchases = await db.collection('purchases').find({ status: 'approved' }).toArray();
    res.json(purchases);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] [${requestId}] Erro ao buscar compras: ${error.message}`);
    res.status(500).json({ error: 'Erro ao buscar compras', details: error.message });
  }
});

app.get('/winning_numbers', async (req, res) => {
  const requestId = uuidv4();
  try {
    if (!db) throw new Error('MongoDB não conectado');
    const winningPrizes = await db.collection('winning_prizes').find().toArray();
    const formattedWinners = winningPrizes.map(prize => `${prize.number}:${prize.prize}:${prize.instagram || ''}`);
    res.json(formattedWinners);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] [${requestId}] Erro ao buscar números premiados: ${error.message}`);
    res.status(500).json({ error: 'Erro ao buscar números premiados', details: error.message });
  }
});

app.get('/get_winners', async (req, res) => {
  const requestId = uuidv4();
  try {
    if (!db) throw new Error('MongoDB não conectado');
    const winners = await db.collection('winners').find().toArray();
    res.json(winners);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] [${requestId}] Erro ao buscar ganhadores: ${error.message}`);
    res.status(500).json({ error: 'Erro ao buscar ganhadores', details: error.message });
  }
});

app.post('/save_winner', async (req, res) => {
  const requestId = uuidv4();
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
    console.error(`[${new Date().toISOString()}] [${requestId}] Erro ao salvar ganhador: ${error.message}`);
    res.status(500).json({ error: 'Erro ao salvar ganhador', details: error.message });
  }
});

app.post('/create_preference', async (req, res) => {
  const requestId = uuidv4();
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

    if (!db) throw new Error('MongoDB não conectado');
    const purchases = await db.collection('purchases').find({ status: 'approved' }).toArray();
    const soldNumbers = purchases.flatMap(p => p.numbers || []);
    const invalidNumbers = numbers.filter(num => soldNumbers.includes(num));
    if (invalidNumbers.length > 0) {
      return res.status(400).json({ error: `Números indisponíveis: ${invalidNumbers.join(', ')}` });
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

    await db.collection('purchases').updateOne(
      { userId, status: 'reserved', numbers: { $all: numbers } },
      {
        $set: {
          status: 'pending',
          buyerName,
          buyerPhone,
          timestamp: new Date()
        }
      },
      { upsert: true }
    );

    const response = await preference.create(preferenceData);
    console.log(`[${new Date().toISOString()}] [${requestId}] Preferência criada: ${response.id}`);
    res.json({ init_point: response.init_point, preference_id: response.id });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] [${requestId}] Erro ao criar preferência: ${error.message}`, error);
    res.status(500).json({ error: 'Erro ao criar preferência', details: error.message, stack: error.stack });
  }
});

app.post('/webhook', async (req, res) => {
  const requestId = uuidv4();
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
      console.error(`[${new Date().toISOString()}] [${requestId}] Erro ao parsear external_reference: ${e.message}`);
      return res.status(400).send('Invalid external reference');
    }
    const { numbers, userId, buyerName, buyerPhone } = externalReference;

    if (!numbers || !userId || !buyerName || !buyerPhone) {
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

    const session = client.startSession();
    try {
      await session.withTransaction(async () => {
        const updateResult = await db.collection('purchases').updateOne(
          { userId, status: 'pending', numbers: { $all: numbers } },
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
        console.log(`[${new Date().toISOString()}] [${requestId}] Pagamento ${paymentId} aprovado. Números ${numbers.join(', ')} aprovados para ${buyerName}.`);
      });
    } catch (error) {
      console.error(`[${new Date().toISOString()}] [${requestId}] Erro na transação do webhook: ${error.message}`);
      throw error;
    } finally {
      session.endSession();
    }
    return res.status(200).send('OK');
  } catch (error) {
    console.error(`[${new Date().toISOString()}] [${requestId}] Erro no webhook: ${error.message}`);
    return res.status(200).send('OK');
  }
});

app.get('/get-page-password', (req, res) => {
  const requestId = uuidv4();
  try {
    const password = process.env.PAGE_PASSWORD;
    if (!password) {
      console.error(`[${new Date().toISOString()}] [${requestId}] Senha não configurada no servidor`);
      return res.status(500).json({ error: 'Senha não configurada no servidor' });
    }
    const hash = crypto.createHash('sha256').update(password).digest('hex');
    res.json({ passwordHash: hash });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] [${requestId}] Erro ao obter hash da senha: ${error.message}`);
    res.status(500).json({ error: 'Erro ao obter hash da senha', details: error.message });
  }
});

app.get('/test_payment/:id', async (req, res) => {
  const requestId = uuidv4();
  try {
    const paymentId = req.params.id;
    const payment = new Payment(mp);
    const paymentDetails = await payment.get({ id: paymentId });
    res.json({ paymentDetails, preferenceId: paymentDetails.preference_id || 'Não encontrado' });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] [${requestId}] Erro ao testar pagamento: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

app.get('/test_preference/:id', async (req, res) => {
  const requestId = uuidv4();
  try {
    const preferenceId = req.params.id;
    const preference = new Preference(mp);
    const preferenceDetails = await preference.get({ id: preferenceId });
    res.json({ preferenceDetails, externalReference: preferenceDetails.external_reference || 'Não encontrado' });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] [${requestId}] Erro ao testar preferência: ${error.message}`);
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
```
