const express = require('express');
const cors = require('cors');
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');
const { MongoClient } = require('mongodb');
const path = require('path');

const app = express();
app.use(cors({
  origin: 'https://ederamorimth.github.io',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type']
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname)));

const mp = new MercadoPagoConfig({
  accessToken: process.env.ACCESS_TOKEN_MP
});

const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
let db;

async function connectDB() {
  try {
    await client.connect();
    db = client.db('numeros-instantaneo');
    console.log('Conectado ao MongoDB!');
  } catch (error) {
    console.error('Erro ao conectar ao MongoDB:', error.message);
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
      console.log('[' + new Date().toISOString() + '] ' + result.deletedCount + ' reservas expiradas removidas.');
    }
  } catch (error) {
    console.error('Erro ao limpar reservas expiradas:', error.message);
  }
}
setInterval(clearExpiredReservations, 5 * 60 * 1000);

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

app.get('/available_numbers', async (req, res) => {
  try {
    if (!db) throw new Error('MongoDB não conectado');
    const purchases = await db.collection('purchases').find().toArray();
    const soldOrReservedNumbers = purchases.flatMap(p => p.numbers || []);
    const allNumbers = Array.from({ length: 900 }, (_, i) => String(i + 1).padStart(4, '0'));
    const availableNumbers = allNumbers.filter(num => !soldOrReservedNumbers.includes(num));
    res.json(availableNumbers);
  } catch (error) {
    console.error('Erro ao buscar números disponíveis:', error.message);
    res.status(500).json({ error: 'Erro ao buscar números disponíveis', details: error.message });
  }
});

app.get('/progress', async (req, res) => {
  try {
    const totalNumbers = 900;
    const purchases = await db.collection('purchases').find().toArray();
    const soldNumbers = purchases.filter(p => p.status === 'sold' || p.status === 'approved').flatMap(p => p.numbers || []).length;
    const progress = (soldNumbers / totalNumbers) * 100;
    res.json({ progress: progress.toFixed(2) });
  } catch (error) {
    console.error('Erro ao calcular progresso:', error);
    res.status(500).json({ error: 'Erro ao calcular progresso' });
  }
});

app.post('/reserve_numbers', async (req, res) => {
  try {
    const { numbers, userId } = req.body;
    if (!numbers || !Array.isArray(numbers) || numbers.length === 0 || !userId) {
      return res.status(400).json({ error: 'Números ou userId inválidos' });
    }
    const purchases = await db.collection('purchases').find().toArray();
    const soldOrReservedNumbers = purchases.flatMap(p => p.numbers || []);
    const invalidNumbers = numbers.filter(num => soldOrReservedNumbers.includes(num));
    if (invalidNumbers.length > 0) {
      return res.status(400).json({ error: 'Números indisponíveis: ' + invalidNumbers.join(', ') });
    }
    const insertResult = await db.collection('purchases').insertOne({
      numbers,
      userId,
      status: 'reserved',
      timestamp: new Date(),
      buyerName: '',
      buyerPhone: ''
    });
    console.log('[' + new Date().toISOString() + '] Números reservados: ' + numbers.join(', ') + ' para userId: ' + userId);
    res.json({ success: true, insertId: insertResult.insertedId });
  } catch (error) {
    console.error('Erro ao reservar números:', error.message);
    res.status(500).json({ error: 'Erro ao reservar números', details: error.message });
  }
});

app.get('/purchases', async (req, res) => {
  try {
    const purchases = await db.collection('purchases').find().toArray();
    res.json(purchases);
  } catch (error) {
    console.error('Erro ao buscar compras:', error);
    res.status(500).json({ error: 'Erro ao buscar compras' });
  }
});

app.post('/verify_password', (req, res) => {
  try {
    const { password } = req.body;
    const correctPassword = process.env.SORTEIO_PASSWORD || 'VAIDACERTO';
    console.log('[' + new Date().toISOString() + '] Verificando senha');

    if (!password) {
      console.log('[' + new Date().toISOString() + '] Erro: Senha não fornecida');
      return res.status(400).json({ error: 'Senha não fornecida' });
    }

    if (password === correctPassword) {
      console.log('[' + new Date().toISOString() + '] Senha válida');
      res.json({ valid: true });
    } else {
      console.log('[' + new Date().toISOString() + '] Senha inválida');
      res.json({ valid: false });
    }
  } catch (error) {
    console.error('[' + new Date().toISOString() + '] Erro ao verificar senha:', error.message);
    res.status(500).json({ error: 'Erro ao verificar senha', details: error.message });
  }
});

app.get('/sorteio', async (req, res) => {
  try {
    const password = req.query.password;
    const correctPassword = process.env.SORTEIO_PASSWORD || 'VAIDACERTO';
    console.log(`[${new Date().toISOString()}] Verificando acesso à página de sorteio com senha fornecida`);

    if (!password) {
      console.log(`[${new Date().toISOString()}] Senha não fornecida`);
      return res.status(400).json({ error: 'Senha não fornecida' });
    }

    if (password === correctPassword) {
      console.log(`[${new Date().toISOString()}] Senha válida, servindo sorteio.html`);
      const filePath = path.join(__dirname, 'sorteio.html');
      res.sendFile(filePath, (err) => {
        if (err) {
          console.error(`[${new Date().toISOString()}] Erro ao servir sorteio.html:`, err.message);
          return res.status(500).json({ error: 'Erro ao carregar a página de sorteio', details: err.message });
        }
      });
    } else {
      console.log(`[${new Date().toISOString()}] Senha inválida`);
      return res.status(401).json({ error: 'Acesso não autorizado. Senha incorreta.' });
    }
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Erro ao processar a rota /sorteio:`, error.message);
    return res.status(500).json({ error: 'Erro interno do servidor', details: error.message });
  }
});

app.post('/check_purchase', async (req, res) => {
  try {
    const { numbers, buyerPhone } = req.body;
    if (!numbers || !Array.isArray(numbers) || !buyerPhone) {
      return res.status(400).json({ error: 'Números ou telefone inválidos' });
    }
    if (!db) throw new Error('MongoDB não conectado');
    
    const purchase = await db.collection('purchases').findOne({
      numbers: { $in: numbers },
      buyerPhone,
      status: 'approved'
    });
    
    if (purchase) {
      res.json({ owned: true, buyerName: purchase.buyerName || 'Anônimo' });
    } else {
      res.json({ owned: false });
    }
  } catch (error) {
    console.error('Erro ao verificar compra:', error.message);
    res.status(500).json({ error: 'Erro ao verificar compra', details: error.message });
  }
});

app.get('/winning_numbers', async (req, res) => {
  try {
    if (!db) throw new Error('MongoDB não conectado');
    const winningPrizes = await db.collection('winning_prizes').find().toArray();
    const formattedWinners = winningPrizes.map(prize => prize.number + ':' + prize.prize + ':' + (prize.instagram || ''));
    res.json(formattedWinners);
  } catch (error) {
    console.error('Erro ao buscar números premiados:', error.message);
    res.status(500).json({ error: 'Erro ao buscar números premiados', details: error.message });
  }
});

app.get('/get_winners', async (req, res) => {
  try {
    if (!db) throw new Error('MongoDB não conectado');
    const winners = await db.collection('winners').find().toArray();
    res.json(winners);
  } catch (error) {
    console.error('Erro ao buscar ganhadores:', error.message);
    res.status(500).json({ error: 'Erro ao buscar ganhadores', details: error.message });
  }
});

app.post('/save_winner', async (req, res) => {
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
    console.error('Erro ao salvar ganhador:', error.message);
    res.status(500).json({ error: 'Erro ao salvar ganhador', details: error.message });
  }
});

app.post('/test_create_preference', (req, res) => {
  console.log('Test request body:', req.body);
  res.json({ received: req.body, status: 'Test endpoint working' });
});

app.post('/create_preference', async (req, res) => {
  try {
    const { quantity, buyerName, buyerPhone, numbers, userId } = req.body;
    console.log('Received request body at: ' + new Date().toISOString(), { quantity, buyerName, buyerPhone, numbers, userId });

    if (!numbers || !Array.isArray(numbers) || numbers.length === 0) {
      console.log('Error: Invalid or missing numbers');
      return res.status(400).json({ error: 'Por favor, selecione pelo menos um número' });
    }
    if (!buyerName || !buyerPhone || !userId) {
      console.log('Error: Missing name, phone, or userId');
      return res.status(400).json({ error: 'Nome, telefone e userId são obrigatórios' });
    }
    if (!quantity || quantity !== numbers.length) {
      console.log('Error: Invalid quantity');
      return res.status(400).json({ error: 'Quantidade inválida ou não corresponde aos números selecionados' });
    }

    const validNumbers = await db.collection('purchases').find({
      numbers: { $in: numbers },
      status: 'reserved',
      userId
    }).toArray();
    if (validNumbers.length !== numbers.length) {
      console.error('[' + new Date().toISOString() + '] Números não estão reservados para o usuário: ' + userId);
      return res.status(400).json({ error: 'Números não estão reservados para este usuário' });
    }

    const preference = new Preference(mp);
    const preferenceData = {
      body: {
        items: [{
          title: 'Rifa - ' + quantity + ' número(s)',
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
    console.log('Preference created successfully, init_point:', response.init_point, 'Preference ID:', response.id);
    res.json({ init_point: response.init_point, preference_id: response.id });
  } catch (error) {
    console.error('Error in /create_preference at: ' + new Date().toISOString(), error.message, 'Stack:', error.stack);
    res.status(500).json({ error: 'Erro ao criar preferência', details: error.message });
  }
});

app.post('/webhook', async (req, res) => {
  try {
    console.log('Webhook received at: ' + new Date().toISOString(), 'Method:', req.method, 'Raw Body:', JSON.stringify(req.body, null, 2));
    if (req.method !== 'POST') {
      console.log('Method not allowed:', req.method);
      return res.status(405).send('Method Not Allowed');
    }

    const body = req.body;
    let paymentId = null;

    if (body.type === 'payment' && body.data && body.data.id) {
      paymentId = body.data.id;
    } else if (body.resource && typeof body.resource === 'string' && body.resource.match(/^\d+$/)) {
      paymentId = body.resource;
    } else if (body.action === 'payment.updated' && body.data && body.data.id) {
      paymentId = body.data.id;
    } else if (body.topic === 'merchant_order' && body.resource) {
      const merchantOrderId = body.resource.match(/\/(\d+)$/)[1];
      const payment = new Payment(mp);
      const orders = await payment.search({ filters: { merchant_order_id: merchantOrderId } });
      if (orders.results && orders.results.length > 0) {
        paymentId = orders.results[0].id;
      }
    }

    if (!paymentId) {
      console.log('No valid payment ID found:', JSON.stringify(body, null, 2));
      return res.status(200).send('OK');
    }

    const payment = new Payment(mp);
    const paymentDetails = await payment.get({ id: paymentId });
    console.log('Payment details:', {
      id: paymentDetails.id,
      status: paymentDetails.status,
      preference_id: paymentDetails.preference_id || 'Não encontrado',
      external_reference: paymentDetails.external_reference || 'Não encontrado',
      transaction_amount: paymentDetails.transaction_amount || 'Não encontrado',
      date_approved: paymentDetails.date_approved || 'Não aprovado ainda'
    });

    if (paymentDetails.status === 'approved') {
      let externalReference;
      try {
        externalReference = JSON.parse(paymentDetails.external_reference || '{}');
      } catch (e) {
        console.error('[' + new Date().toISOString() + '] Erro ao parsear external_reference:', e);
        return res.status(400).send('Invalid external reference');
      }
      const { numbers, userId, buyerName, buyerPhone } = externalReference;

      if (!numbers || !userId || !buyerName || !buyerPhone) {
        console.error('[' + new Date().toISOString() + '] Dados incompletos no external_reference:', externalReference);
        return res.status(400).send('Dados incompletos no external_reference');
      }

      if (!db) {
        console.error('MongoDB não conectado');
        return res.status(500).send('Erro: MongoDB não conectado');
      }

      const validNumbers = await db.collection('purchases').find({
        numbers: { $in: numbers },
        status: 'reserved',
        userId
      }).toArray();

      if (validNumbers.length !== numbers.length) {
        console.error('[' + new Date().toISOString() + '] Números não estão reservados para o usuário: ' + userId + ', encontrados: ' + validNumbers.length + ', esperados: ' + numbers.length);
        return res.status(400).send('Números não estão reservados para o usuário');
      }

      const session = client.startSession();
      try {
        await session.withTransaction(async () => {
          const updateResult = await db.collection('purchases').updateOne(
            { numbers: { $all: numbers }, status: 'reserved', userId },
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

          if (updateResult.modifiedCount === 0) {
            console.error('[' + new Date().toISOString() + '] Nenhum documento atualizado para números: ' + numbers.join(', ') + ', userId: ' + userId);
            throw new Error('Nenhum documento correspondente encontrado para atualização');
          }

          console.log('[' + new Date().toISOString() + '] Pagamento ' + paymentId + ' aprovado. Números ' + numbers.join(', ') + ' marcados como aprovados para ' + buyerName + '.');
        });
      } catch (error) {
        console.error('[' + new Date().toISOString() + '] Erro na transação:', error);
        throw error;
      } finally {
        session.endSession();
      }
    } else {
      console.log('[' + new Date().toISOString() + '] Pagamento ' + paymentId + ' não está aprovado. Status: ' + paymentDetails.status);
    }

    return res.status(200).send('OK');
  } catch (error) {
    console.error('Erro no webhook:', error.message);
    return res.status(200).send('OK');
  }
});

app.get('/test_payment/:id', async (req, res) => {
  try {
    const paymentId = req.params.id;
    const payment = new Payment(mp);
    const paymentDetails = await payment.get({ id: paymentId });
    res.json({ paymentDetails, preferenceId: paymentDetails.preference_id || 'Não encontrado' });
  } catch (error) {
    console.error('[' + new Date().toISOString() + '] Erro ao testar pagamento:', error.message);
    res.status(500).json({ error: 'Erro ao buscar detalhes do pagamento', details: error.message });
  }
});

app.get('/test_preference/:id', async (req, res) => {
  try {
    const preferenceId = req.params.id;
    const preference = new Preference(mp);
    const preferenceDetails = await preference.get({ id: preferenceId });
    res.json({ preferenceDetails, externalReference: preferenceDetails.external_reference || 'Não encontrado' });
  } catch (error) {
    console.error('[' + new Date().toISOString() + '] Erro ao testar preferência:', error.message);
    res.status(500).json({ error: 'Erro ao buscar detalhes da preferência', details: error.message });
  }
});

app.get('/', (req, res) => {
  res.send('API da Rifa está online!');
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log('Servidor rodando na porta ' + PORT + ' at ' + new Date().toISOString());
});
