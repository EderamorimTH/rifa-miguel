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

// Test endpoints
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

// Endpoint para números disponíveis
app.get('/available_numbers', async (req, res) => {
  const requestId = uuidv4();
  console.log(`[${new Date().toISOString()}] [${requestId}] Consultando números disponíveis...`);
  try {
    if (!db) throw new Error('MongoDB não conectado');
    const purchases = await db.collection('purchases').find().toArray();
    const soldOrReservedNumbers = purchases.flatMap(p => p.numbers || []);
    const allNumbers = Array.from({ length: 900 }, (_, i) => String(i + 1).padStart(4, '0'));
    const availableNumbers = allNumbers.filter(num => !soldOrReservedNumbers.includes(num));
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
    const totalNumbers = 900;
    const purchases = await db.collection('purchases').find().toArray();
    const soldNumbers = purchases.filter(p => p.status === 'sold' || p.status === 'approved').flatMap(p => p.numbers || []).length;
    const progress = (soldNumbers / totalNumbers) * 100;
    res.json({ progress: progress.toFixed(2) });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] [${requestId}] Erro ao calcular progresso:`, error.message);
    res.status(500).json({ error: 'Erro ao calcular progresso' });
  }
});

// Endpoint para reservar números
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
    const invalidNumbers = numbers.filter(num => soldOrReservedNumbers.includes(num));
    if (invalidNumbers.length > 0) {
      return res.status(400).json({ error: `Números indisponíveis: ${invalidNumbers.join(', ')}` });
    }
    const insertResult = await db.collection('purchases').insertOne({
      numbers,
      userId,
      status: 'reserved',
     she session = client.startSession();
      try {
        await session.withTransaction(async () => {
          const updateResult = await db.collection('purchases').updateOne(
            { numbers: { $in: numbers }, status: 'reserved', userId },
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
        console.error(`[${new Date().toISOString()}] [${requestId}] Erro na transação:`, error);
        throw error;
      } finally {
        session.endSession();
      }
    }
    return res.status(200).send('OK');
  } catch (error) {
    console.error(`[${new Date().toISOString()}] [${requestId}] Erro no webhook:`, error.message);
    return res.status(200).send('OK');
  }
});

// Novo endpoint para obter o hash da senha
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

// Test endpoints
app.get('/test_payment/:id', async (req, res) => {
  const requestId = uuidv4();
  console.log(`[${new Date().toISOString()}] [${requestId}] Testando pagamento: ${req.params.id}`);
  try {
    const paymentId = req.params.id;
    const payment = new Payment(mp);
    const paymentDetails = await payment.get({ id: paymentId });
    res.json({ paymentDetails, preferenceId: paymentDetails.preference_id || 'Não encontrado' });
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
    res.json({ preferenceDetails, externalReference: preferenceDetails.external_reference || 'Não encontrado' });
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
