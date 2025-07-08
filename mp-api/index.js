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

const mp = new MercadoPagoConfig({ accessToken: process.env.ACCESS_TOKEN_MP });

const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
let db;

async function connectDB() {
  const maxRetries = 5;
  for (let retries = 0; retries < maxRetries; retries++) {
    try {
      await client.connect();
      db = client.db('numeros-instantaneo');
      console.log('Conectado ao MongoDB!');
      return;
    } catch (err) {
      console.error(`Erro ao conectar ao MongoDB (tentativa ${retries + 1}):`, err.message);
      await new Promise(res => setTimeout(res, 2000));
    }
  }
  process.exit(1);
}
connectDB();

async function clearExpiredReservations() {
  try {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    const result = await db.collection('purchases').deleteMany({
      status: 'reserved',
      timestamp: { $lt: fiveMinutesAgo }
    });
    if (result.deletedCount) {
      console.log(`[${new Date().toISOString()}] ${result.deletedCount} reservas expiradas removidas.`);
    }
  } catch (err) {
    console.error('Erro ao limpar reservas expiradas:', err.message);
  }
}
setInterval(clearExpiredReservations, 5 * 60 * 1000);

app.post('/webhook', async (req, res) => {
  const requestId = uuidv4();
  console.log(`[${new Date().toISOString()}] [${requestId}] Webhook recebido:`, req.body);
  try {
    const paymentId = req.body.data?.id || null;
    if (!paymentId) return res.status(200).send('OK');

    const payment = new Payment(mp);
    const paymentDetails = await payment.get({ id: paymentId });
    if (paymentDetails.status !== 'approved') return res.status(200).send('OK');

    const ref = JSON.parse(paymentDetails.external_reference || '{}');
    const { numbers, userId, buyerName, buyerPhone } = ref;
    if (!numbers || !userId || !buyerName || !buyerPhone) return res.status(400).send('Dados incompletos');

    const session = client.startSession();
    try {
      await session.withTransaction(async () => {
        const updateResult = await db.collection('purchases').updateMany(
          { numbers: { $in: numbers }, status: 'reserved', userId },
          {
            $set: {
              status: 'approved',
              buyerName,
              buyerPhone,
              paymentId: paymentDetails.id,
              date_approved: paymentDetails.date_approved || new Date(),
              preference_id: paymentDetails.preference_id || 'N/A',
              userId: null,
              timestamp: null
            }
          },
          { session }
        );

        if (updateResult.matchedCount !== numbers.length) {
          throw new Error('Nem todos os números foram atualizados corretamente.');
        }

        console.log(`[${new Date().toISOString()}] [${requestId}] Pagamento ${paymentId} processado com sucesso.`);
      });
    } catch (err) {
      console.error(`[${new Date().toISOString()}] [${requestId}] Erro na transação:`, err.message);
      return res.status(500).send('Erro ao processar pagamento');
    } finally {
      session.endSession();
    }
    res.status(200).send('OK');
  } catch (err) {
    console.error(`[${new Date().toISOString()}] [${requestId}] Erro no webhook:`, err.message);
    res.status(200).send('OK');
  }
});

app.listen(process.env.PORT || 10000, () => {
  console.log(`Servidor rodando na porta ${process.env.PORT || 10000}`);
});
