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
    const soldNumbers = purchases.flatMap(p => p.numbers || []);
    console.log(`Números vendidos encontrados: ${soldNumbers.length}`);
    const allNumbers = Array.from({ length: 1700 }, (_, i) => String(i + 1).padStart(4, '0'));
    const availableNumbers = allNumbers.filter(num => !soldNumbers.includes(num));
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
    const totalNumbers = 1700;
    const purchases = await db.collection('purchases').find().toArray();
    const soldNumbers = purchases.flatMap(p => p.numbers || []).length;
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
    console.log('Received request body at:', new Date().toISOString(), { quantity, buyerName, buyerPhone, numbers });
    if (typeof numbers === 'undefined') {
      console.log('Warning: numbers is undefined in request body');
    }

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

    console.log('Verifying available numbers...');
    const purchases = await db.collection('purchases').find().toArray();
    const soldNumbers = purchases.flatMap(p => p.numbers || []);
    const invalidNumbers = numbers.filter(num => soldNumbers.includes(num));
    if (invalidNumbers.length > 0) {
      console.log('Invalid numbers detected:', invalidNumbers);
      return res.status(400).json({ error: `Números indisponíveis: ${invalidNumbers.join(', ')}` });
    }

    console.log('Creating Mercado Pago preference...');
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
        external_reference: JSON.stringify({ buyerName, buyerPhone, numbers }),
        notification_url: "https://rifa-miguel.onrender.com/webhook" // Adiciona URL de notificação
      }
    };

    const response = await preference.create(preferenceData);
    console.log('Preference created successfully, init_point:', response.init_point, 'Preference ID:', response.id);
    res.json({ init_point: response.init_point });
  } catch (error) {
    console.error('Error in /create_preference at:', new Date().toISOString(), error.message, 'Stack:', error.stack);
    res.status(500).json({ error: 'Erro ao criar preferência', details: error.message });
  }
});

// Endpoint para webhook (suporta GET e POST)
app.all('/webhook', async (req, res) => {
  try {
    console.log('Webhook received:', req.body);
    if (req.method === 'GET') {
      console.log('GET request received, responding with OK for test');
      return res.status(200).send('Webhook endpoint is active');
    }
    if (req.method === 'POST') {
      const { type, data } = req.body;
      console.log('Processing POST webhook...', 'Type:', type, 'Data:', data);
      if (type === 'payment') {
        let paymentStatus;
        let paymentDetails;
        if (data && data.id) {
          try {
            const payment = new Payment(mp);
            paymentDetails = await payment.get({ id: data.id });
            paymentStatus = paymentDetails.status;
            console.log('Payment status:', paymentStatus, 'Payment details:', {
              id: paymentDetails.id,
              status: paymentDetails.status,
              preference_id: paymentDetails.preference_id || 'Não encontrado',
              external_reference: paymentDetails.external_reference || 'Não encontrado'
            });
          } catch (error) {
            console.log('Erro ao buscar pagamento:', error.message);
            return res.status(200).send('OK'); // Ignora erro para testes
          }
        } else {
          console.log('No payment ID or status found, skipping processing');
          return res.status(200).send('OK');
        }

        if (paymentStatus === 'approved') {
          console.log('Payment approved, processing webhook...', 'Payment data:', data);
          // Tenta usar external_reference diretamente do pagamento
          let externalReference = paymentDetails.external_reference;
          let buyerName, buyerPhone, numbers;
          if (externalReference) {
            try {
              const parsed = JSON.parse(externalReference);
              buyerName = parsed.buyerName;
              buyerPhone = parsed.buyerPhone;
              numbers = parsed.numbers;
              console.log('Parsed external reference from payment:', { buyerName, buyerPhone, numbers });
            } catch (e) {
              console.error('Erro ao parsear external_reference do pagamento:', e.message);
              return res.status(200).send('OK');
            }
          } else {
            // Tenta buscar via preference_id
            const preferenceId = data.preference_id || (data && data.id && await getPreferenceIdFromPayment(data.id));
            if (!preferenceId) {
              console.log('Preference ID não encontrado, ignorando');
              return res.status(200).send('OK');
            }
            let preference;
            try {
              preference = await new Preference(mp).get({ id: preferenceId });
              console.log('Preference retrieved:', preference);
              try {
                externalReference = JSON.parse(preference.external_reference);
                buyerName = externalReference.buyerName;
                buyerPhone = externalReference.buyerPhone;
                numbers = externalReference.numbers;
                console.log('Parsed external reference from preference:', { buyerName, buyerPhone, numbers });
              } catch (e) {
                console.error('Erro ao parsear external_reference da preferência:', e.message);
                return res.status(200).send('OK');
              }
            } catch (error) {
              console.error('Erro ao buscar preferência:', error.message);
              return res.status(200).send('OK');
            }
          }

          // Valida dados antes de salvar
          if (!buyerName || !buyerPhone || !numbers || !Array.isArray(numbers)) {
            console.error('Dados inválidos para salvar compra:', { buyerName, buyerPhone, numbers });
            return res.status(200).send('OK');
          }

          // Salvar no MongoDB
          if (!db) {
            console.error('MongoDB não conectado');
            return res.status(500).send('Erro: MongoDB não conectado');
          }
          const result = await db.collection('purchases').insertOne({
            buyerName,
            buyerPhone,
            numbers,
            purchaseDate: new Date(),
            paymentId: data.id
          });
          console.log('Purchase saved successfully:', result.insertedId, { buyerName, buyerPhone, numbers });
        } else {
          console.log('Webhook ignored, status:', paymentStatus);
        }
      } else {
        console.log('Webhook ignored, type:', type);
      }
      return res.status(200).send('OK');
    }
    return res.status(405).send('Method Not Allowed');
  } catch (error) {
    console.error('Erro no webhook:', error.message);
    return res.status(500).send('Erro no webhook');
  }
});

// Função auxiliar para buscar preference_id a partir do payment_id
async function getPreferenceIdFromPayment(paymentId) {
  try {
    const payment = new Payment(mp);
    const paymentDetails = await payment.get({ id: paymentId });
    console.log('Payment details for preference_id:', {
      paymentId,
      preference_id: paymentDetails.preference_id || 'Não encontrado',
      status: paymentDetails.status,
      external_reference: paymentDetails.external_reference || 'Não encontrado'
    });
    return paymentDetails.preference_id || null;
  } catch (error) {
    console.error('Erro ao buscar preference_id:', error.message);
    return null;
  }
}

// Rota para verificar a senha
app.post('/verify_password', (req, res) => {
  try {
    const { password } = req.body;
    const correctPassword = process.env.SORTEIO_PASSWORD || 'VAIDACERTO'; // Usa variável de ambiente
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
