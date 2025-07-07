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

// Configura Mercado Pago
const mp = new MercadoPagoConfig({
  accessToken: process.env.ACCESS_TOKEN_MP
});

// Conexão MongoDB
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

      // Remove duplicatas (reservas duplicadas para mesmo userId e números)
      const duplicates = await db.collection('purchases').aggregate([
        { $match: { status: { $in: ['reserved', 'pending'] } } },
        { $group: { _id: { numbers: "$numbers", userId: "$userId" }, count: { $sum: 1 }, ids: { $push: "$_id" } } },
        { $match: { count: { $gt: 1 } } }
      ]).toArray();

      for (const dup of duplicates) {
        const idsToRemove = dup.ids.slice(1);
        await db.collection('purchases').deleteMany({ _id: { $in: idsToRemove } });
        console.log(`Removidas duplicatas para userId ${dup._id.userId} e números ${dup._id.numbers.join(',')}`);
      }

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

// Limpa reservas expiradas (mais de 5 minutos)
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

// ENDPOINTS

// Health check para evitar 404 no frontend
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Teste conexão MongoDB
app.get('/test_db', async (req, res) => {
  try {
    const collections = await db.listCollections().toArray();
    res.json({ status: 'MongoDB conectado!', collections });
  } catch (error) {
    res.status(500).json({ error: 'Erro no MongoDB', message: error.message });
  }
});

// Teste Mercado Pago SDK
app.get('/test_mp', async (req, res) => {
  try {
    const preference = new Preference(mp);
    res.json({ status: 'Mercado Pago SDK inicializado com sucesso' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao inicializar Mercado Pago', message: error.message });
  }
});

// Disponibilidade dos números (gera todos, exclui vendidos/reservados)
app.get('/available_numbers', async (req, res) => {
  try {
    const purchases = await db.collection('purchases').find({ status: { $in: ['reserved', 'approved'] } }).toArray();
    const soldOrReservedNumbers = purchases.flatMap(p => p.numbers || []);
    const allNumbers = Array.from({ length: 900 }, (_, i) => String(i + 1).padStart(4, '0'));
    const availableNumbers = allNumbers.filter(num => !soldOrReservedNumbers.includes(num));
    res.json(availableNumbers);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao buscar números disponíveis', details: error.message });
  }
});

// Reservar números (agrupa reservas para o mesmo userId)
app.post('/reserve_numbers', async (req, res) => {
  const { numbers, userId } = req.body;
  if (!numbers || !Array.isArray(numbers) || numbers.length === 0 || !userId) {
    return res.status(400).json({ error: 'Números ou userId inválidos' });
  }
  try {
    const purchases = await db.collection('purchases').find({ status: { $in: ['reserved', 'approved'] } }).toArray();
    const soldOrReservedNumbers = purchases.flatMap(p => p.numbers || []);
    const invalidNumbers = numbers.filter(num => soldOrReservedNumbers.includes(num));
    if (invalidNumbers.length > 0) {
      return res.status(400).json({ error: `Números indisponíveis: ${invalidNumbers.join(', ')}` });
    }

    // Verifica se já existe reserva para esse userId
    const existingReservation = await db.collection('purchases').findOne({ userId, status: 'reserved' });

    if (existingReservation) {
      // Atualiza adicionando novos números e atualiza timestamp
      await db.collection('purchases').updateOne(
        { _id: existingReservation._id },
        {
          $addToSet: { numbers: { $each: numbers } },
          $set: { timestamp: new Date() }
        }
      );
      res.json({ success: true, updated: true });
    } else {
      // Insere nova reserva
      const insertResult = await db.collection('purchases').insertOne({
        numbers,
        userId,
        status: 'reserved',
        timestamp: new Date(),
        buyerName: '',
        buyerPhone: ''
      });
      res.json({ success: true, insertId: insertResult.insertedId });
    }
  } catch (error) {
    res.status(500).json({ error: 'Erro ao reservar números', details: error.message });
  }
});

// Criar preferência Mercado Pago
app.post('/create_preference', async (req, res) => {
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
  try {
    const validNumbers = await db.collection('purchases').find({
      numbers: { $all: numbers },
      status: 'reserved',
      userId
    }).toArray();

    if (validNumbers.length === 0) {
      return res.status(400).json({ error: 'Números não estão reservados para este usuário' });
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
    res.json({ init_point: response.init_point, preference_id: response.id });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao criar preferência', details: error.message });
  }
});

// Webhook Mercado Pago para atualizar status da compra
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;
    const paymentId = body.data?.id;
    if (!paymentId) return res.status(200).send('OK');

    const payment = new Payment(mp);
    const paymentDetails = await payment.get({ id: paymentId });
    if (paymentDetails.status !== 'approved') return res.status(200).send('OK');

    let externalReference;
    try {
      externalReference = JSON.parse(paymentDetails.external_reference || '{}');
    } catch {
      return res.status(400).send('Invalid external reference');
    }
    const { numbers, userId, buyerName, buyerPhone } = externalReference;
    if (!numbers || !userId || !buyerName || !buyerPhone) {
      return res.status(400).send('Dados incompletos');
    }

    // Verifica se pagamento já processado
    const existing = await db.collection('purchases').findOne({
      paymentId: paymentDetails.id,
      status: 'approved'
    });
    if (existing) return res.status(200).send('OK');

    // Verifica se os números estão reservados para o userId
    const reservation = await db.collection('purchases').findOne({
      status: 'reserved',
      userId,
      numbers: { $all: numbers }
    });
    if (!reservation) return res.status(400).send('Números não estão reservados');

    // Atualiza reserva para aprovado e salva dados do comprador
    await db.collection('purchases').updateOne(
      { _id: reservation._id },
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
      }
    );
    res.status(200).send('OK');
  } catch (error) {
    res.status(200).send('OK');
  }
});

// Endpoint para obter hash da senha
app.get('/get-page-password', (req, res) => {
  const password = process.env.PAGE_PASSWORD;
  if (!password) {
    return res.status(500).json({ error: 'Senha não configurada no servidor' });
  }
  const hash = crypto.createHash('sha256').update(password).digest('hex');
  res.json({ passwordHash: hash });
});

// Root
app.get('/', (req, res) => {
  res.json({ status: 'API da Rifa está online!' });
});

// Start server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT} em ${new Date().toISOString()}`);
});
