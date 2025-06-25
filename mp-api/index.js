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

// Endpoint para verificar números disponíveis
app.get('/available_numbers', async (req, res) => {
  try {
    const purchases = await db.collection('purchases').find().toArray();
    const soldNumbers = purchases.flatMap(p => p.numbers);
    const allNumbers = Array.from({ length: 1700 }, (_, i) => String(i + 1).padStart(4, '0'));
    const availableNumbers = allNumbers.filter(num => !soldNumbers.includes(num));
    res.json(availableNumbers);
  } catch (error) {
    console.error(error);
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
    console.error(error);
    res.status(500).json({ error: 'Erro ao calcular progresso' });
  }
});

// Endpoint para dados do sorteio
app.get('/purchases', async (req, res) => {
  try {
    const purchases = await db.collection('purchases').find().toArray();
    res.json(purchases);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro ao buscar compras' });
  }
});

app.get('/', (req, res) => {
  res.send('API da Rifa está online!');
});

app.post('/create_preference', async (req, res) => {
  try {
    const { quantity, buyerName, buyerPhone, numbers } = req.body;

    // Verificar se os números estão disponíveis
    const purchases = await db.collection('purchases').find().toArray();
    const soldNumbers = purchases.flatMap(p => p.numbers);
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
          unit_price: 10,
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
        external_reference: JSON.stringify({ buyerName, buyerPhone, numbers }) // Passar dados para salvar após aprovação
      }
    };

    const response = await preference.create(preferenceData);
    res.json({ init_point: response.init_point });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro ao criar preferência' });
  }
});

// Endpoint para salvar compra após aprovação
app.post('/webhook', async (req, res) => {
  try {
    const { type, data } = req.body;
    if (type === 'payment' && data.status === 'approved') {
      const preference = await new Preference(mp).get({ id: data.preference_id });
      const { buyerName, buyerPhone, numbers } = JSON.parse(preference.external_reference);

      // Salvar no MongoDB
      await db.collection('purchases').insertOne({
        buyerName,
        buyerPhone,
        numbers,
        purchaseDate: new Date(),
        paymentId: data.id
      });
    }
    res.status(200).send('OK');
  } catch (error) {
    console.error(error);
    res.status(500).send('Erro no webhook');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
