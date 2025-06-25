import express from 'express';
import cors from 'cors';
import { MercadoPagoConfig, Preference } from 'mercadopago';
import { MongoClient } from 'mongodb';

const app = express();
app.use(cors());
app.use(express.json());

// Configura o MercadoPago
const mp = new MercadoPagoConfig({
  accessToken: process.env.ACCESS_TOKEN_MP
});

// Conecta ao MongoDB
const uri = process.env.MONGODB_URI; // String de conexão do MongoDB Atlas
const client = new MongoClient(uri);
let db;

async function connectDB() {
  try {
    await client.connect();
    db = client.db('rifa_miguel');
    console.log('Conectado ao MongoDB!');
  } catch (error) {
    console.error('Erro ao conectar ao MongoDB:', error);
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
    const purchases = await db.collection('purchases').find().toArray();
    const soldNumbers = purchases.flatMap(p => p.numbers);
    const allNumbers = Array.from({ length: 1700 }, (_, i) => String(i + 1).padStart(4, '0'));
    const availableNumbers = allNumbers.filter(num => !soldNumbers.includes(num));
    res.json(availableNumbers);
  } catch (error) {
    console.error('Erro ao buscar números disponíveis:', error);
    res.status(500).json({ error: 'Erro ao buscar números disponíveis' });
  }
});

// Endpoint para calcular progresso
app.get('/progress', async (req, res) => {
  try {
    const totalNumbers = 1700;
    const purchases = await db.collection('purchases').find().toArray();
    const soldNumbers = purchases.flatMap(p => p.numbers).length;
    const progress = (soldNumbers / totalNumbers) * 100;
    res.json({ progress: progress.toFixed(2) });
  } catch (error) {
    console.error('Erro ao calcular progresso:', error);
    res.status(500).json({ error: 'Erro ao calcular progresso' });
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

// Test endpoint to debug request body
app.post('/test_create_preference', (req, res) => {
  console.log('Test request body:', req.body);
  res.json({ received: req.body, status: 'Test endpoint working' });
});

// Endpoint para criar preferência de pagamento
app.post('/create_preference', async (req, res) => {
  try {
    const { quantity, buyerName, buyerPhone, numbers } = req.body;
    console.log('Request body:', { quantity, buyerName, buyerPhone, numbers });

    // Validate inputs
    if (!numbers || !Array.isArray(numbers) || numbers.length === 0) {
      console.log('Error: Invalid or missing numbers');
      return res.status(400).json({ error: 'Por favor, selecione pelo menos um número' });
    }
    if (!buyerName || !buyerPhone) {
      console.log('Error: Missing name or phone');
      return res.status(400).json({ error: 'Nome e telefone são obrigatórios' });
    }
    if (!quantity || quantity !== numbers.length) {
      console.log('Error: Invalid quantity');
      return res.status(400).json({ error: 'Quantidade inválida ou não corresponde aos números selecionados' });
    }

    // Verify available numbers
    const purchases = await db.collection('purchases').find().toArray();
    const soldNumbers = purchases.flatMap(p => p.numbers);
    const invalidNumbers = numbers.filter(num => soldNumbers.includes(num));
    if (invalidNumbers.length > 0) {
      return res.status(400).json({ error: `Números indisponíveis
