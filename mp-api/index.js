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

// Atualização crítica na transação do webhook para garantir múltiplos números aprovados
app.post('/webhook', async (req, res) => {
  const requestId = uuidv4();
  console.log(`[${new Date().toISOString()}] [${requestId}] Webhook recebido:`, req.body);
  try {
    if (req.method !== 'POST') {
      return res.status(405).send('Method Not Allowed');
    }

    const body = req.body;
    let paymentId = body.data?.id || body.resource?.match(/\d+/)?.[0];

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
        for (const number of numbers) {
          const updateResult = await db.collection('purchases').updateOne(
            { numbers: number, status: 'reserved', userId },
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
            throw new Error(`Número ${number} não encontrado ou não reservado corretamente`);
          }
        }
        console.log(`[${new Date().toISOString()}] [${requestId}] Pagamento ${paymentId} aprovado. Números ${numbers.join(', ')} aprovados para ${buyerName}.`);
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
