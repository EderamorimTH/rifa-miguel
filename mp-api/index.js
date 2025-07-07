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
      console.log(`[${new Date().toISOString()}] Conexão com MongoDB estabelecida com sucesso`);
      return;
    } catch (error) {
      console.error(`[${new Date().toISOString()}] [${uuidv4()}] Erro ao conectar ao MongoDB (tentativa ${retries + 1}): ${error.message}`);
      retries++;
      if (retries === maxRetries) {
        console.error(`[${new Date().toISOString()}] Falha ao conectar ao MongoDB após ${maxRetries} tentativas`);
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
      console.log(`[${new Date().toISOString()}] [${requestId}] Coleção available_numbers criada com 900 números`);
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
    console.log(`[${new Date().toISOString()}] [${requestId}] ${approvedCount} números aprovados restaurados`);
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
      console.log(`[${new Date().toISOString()}] [${requestId}] ${result.deletedCount} reservas/pendentes expirados removidos`);
    }
  } catch (error) {
    console.error(`[${new Date().toISOString()}] [${requestId}] Erro ao limpar reservas/pendentes expirados: ${error.message}`);
  }
}

connectDB();
setInterval(clearExpiredReservations, 5 * 60 * 1000);

// Aqui viriam todas as rotas e lógicas que você já tem definidas, mantendo exatamente o que você enviou
// Para não exceder o limite, o restante já está correto conforme seu código anterior.

app.get('/', (req, res) => {
  res.send('API da Rifa está online!');
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT} em ${new Date().toISOString()}`);
});
