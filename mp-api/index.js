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
      console.log('Conectado ao MongoDB!');

      // Limpa duplicatas na inicialização
      const duplicates = await db.collection('purchases').aggregate([
        { $match: { status: { $ne: 'approved' } } },
        { $group: { _id: { numbers: "$numbers", userId: "$userId" }, count: { $sum: 1 }, ids: { $push: "_id" } } },
        { $match: { count: { $gt: 1 } } }
      ]).toArray();
      for (const dup of duplicates) {
        const idsToRemove = dup.ids.slice(1);
        await db.collection('purchases').deleteMany({ _id: { $in: idsToRemove } });
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

// Novo endpoint para testar conexão com DB
app.get('/test_db', async (req, res) => {
  try {
    const collections = await db.listCollections().toArray();
    res.json({ status: 'MongoDB conectado!', collections });
  } catch (error) {
    res.status(500).json({ error: 'Erro no MongoDB', message: error.message });
  }
});

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

app.get('/available_numbers', async (req, res) => {
  const requestId = uuidv4();
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

app.post('/reserve_numbers', async (req, res) => {
  const requestId = uuidv4();
  const { numbers, userId } = req.body;
  if (!numbers || !Array.isArray(numbers) || numbers.length === 0 || !userId) {
    return res.status(400).json({ error: 'Números ou userId inválidos' });
  }

  const purchases = await db.collection('purchases').find({ status: { $in: ['reserved', 'approved'] } }).toArray();
  const soldOrReservedNumbers = purchases.flatMap(p => p.numbers || []);
  const invalidNumbers = numbers.filter(num => soldOrReservedNumbers.includes(num));
  if (invalidNumbers.length > 0) {
    return res.status(400).json({ error: `Números indisponíveis: ${invalidNumbers.join(', ')}` });
  }

  const existing = await db.collection('purchases').findOne({ userId, status: 'reserved' });
  if (existing) {
    await db.collection('purchases').updateOne(
      { _id: existing._id },
      { $addToSet: { numbers: { $each: numbers } }, $set: { timestamp: new Date() } }
    );
    res.json({ success: true, updated: true });
  } else {
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
});

app.post('/webhook', async (req, res) => {
  const requestId = uuidv4();
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
    } catch (e) {
      return res.status(400).send('Invalid external reference');
    }
    const { numbers, userId, buyerName, buyerPhone } = externalReference;
    if (!numbers || !userId || !buyerName || !buyerPhone) {
      return res.status(400).send('Dados incompletos');
    }

    const existingPurchase = await db.collection('purchases').findOne({
      paymentId: paymentDetails.id,
      status: 'approved'
    });
    if (existingPurchase) return res.status(200).send('OK');

    const valid = await db.collection('purchases').findOne({
      status: 'reserved',
      userId,
      numbers: { $all: numbers }
    });

    if (!valid) return res.status(400).send('Números não estão reservados');

    await db.collection('purchases').updateOne(
      { _id: valid._id },
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
    return res.status(200).send('OK');
  }
});

app.listen(process.env.PORT || 10000, () => {
  console.log(`Servidor rodando na porta ${process.env.PORT || 10000}`);
});
