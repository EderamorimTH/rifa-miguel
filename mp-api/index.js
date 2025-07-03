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
    db = client.db('numeros-instantaneo');
    console.log('Conectado ao MongoDB!');
    await initializeNumbers();
  } catch (error) {
    console.error('Erro ao conectar ao MongoDB:', error.message);
  }
}
connectDB();

// Inicializa números (001 a 900)
async function initializeNumbers() {
  try {
    const count = await db.collection('numbers').countDocuments();
    if (count === 0) {
      const numbers = Array.from({ length: 900 }, (_, i) => ({
        number: String(i + 1).padStart(4, '0'),
        status: 'disponível',
        userId: null,
        timestamp: null
      }));
      await db.collection('numbers').insertMany(numbers);
      console.log(`[${new Date().toISOString()}] Números de 0001 a 0900 inicializados na coleção numbers.`);
    } else {
      console.log(`[${new Date().toISOString()}] Coleção numbers já contém ${count} documentos.`);
    }
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Erro ao inicializar números:`, error.message);
  }
}

// Libera reservas expiradas (após 5 minutos)
async function clearExpiredReservations() {
  try {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    const expired = await db.collection('numbers').find({ status: 'reservado', timestamp: { $lt: fiveMinutesAgo } }).toArray();
    const result = await db.collection('numbers').updateMany(
      { status: 'reservado', timestamp: { $lt: fiveMinutesAgo } },
      { $set: { status: 'disponível', userId: null, timestamp: null } }
    );
    if (result.modifiedCount > 0) {
      console.log(`[${new Date().toISOString()}] Liberadas ${result.modifiedCount} reservas expiradas. Números afetados: ${expired.map(n => n.number).join(', ')}`);
    }
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Erro ao liberar reservas expiradas:`, error.message);
  }
}
setInterval(clearExpiredReservations, 5 * 60 * 1000);
clearExpiredReservations();

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
    await clearExpiredReservations();
    const numbers = await db.collection('numbers').find({ status: 'disponível' }).toArray();
    console.log(`[${new Date().toISOString()}] Números disponíveis retornados: ${numbers.length}`);
    res.json(numbers.map(n => n.number));
  } catch (error) {
    console.error('Erro ao buscar números disponíveis:', error.message);
    res.status(500).json({ error: 'Erro ao buscar números disponíveis', details: error.message });
  }
});

// Endpoint para calcular progresso
app.get('/progress', async (req, res) => {
  try {
    const totalNumbers = 900;
    const soldNumbers = await db.collection('numbers').countDocuments({ status: 'vendido' });
    const progress = (soldNumbers / totalNumbers) * 100;
    console.log(`[${new Date().toISOString()}] Progresso: ${progress.toFixed(2)}% (${soldNumbers}/${totalNumbers})`);
    res.json({ progress: progress.toFixed(2) });
  } catch (error) {
    console.error('Erro ao calcular progresso:', error);
    res.status(500).json({ error: 'Erro ao calcular progresso', details: error.message });
  }
});

// Endpoint para reservar números
app.post('/reserve_numbers', async (req, res) => {
  const { numbers, userId } = req.body;
  console.log(`[${new Date().toISOString()}] Recebendo solicitação para reservar números: ${numbers}, userId: ${userId}`);
  try {
    if (!numbers || !Array.isArray(numbers) || numbers.length === 0 || !userId) {
      console.error(`[${new Date().toISOString()}] Dados incompletos na solicitação de reserva`);
      return res.status(400).json({ success: false, message: 'Dados incompletos' });
    }
    const availableNumbers = await db.collection('numbers').find({ number: { $in: numbers }, status: 'disponível' }).toArray();
    if (availableNumbers.length !== numbers.length) {
      console.error(`[${new Date().toISOString()}] Alguns números não estão disponíveis: ${numbers}`);
      return res.status(400).json({ success: false, message: 'Alguns números não estão disponíveis' });
    }
    const result = await db.collection('numbers').updateMany(
      { number: { $in: numbers }, status: 'disponível' },
      { $set: { status: 'reservado', userId, timestamp: new Date() } }
    );
    console.log(`[${new Date().toISOString()}] Números ${numbers.join(', ')} reservados com sucesso para userId: ${userId}`);
    res.json({ success: true });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Erro ao reservar números:`, error.message);
    res.status(500).json({ success: false, message: 'Erro ao reservar números', details: error.message });
  }
});

// Endpoint para verificar reserva
app.post('/check_reservation', async (req, res) => {
  const { numbers, userId } = req.body;
  try {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    const validNumbers = await db.collection('numbers').find({
      number: { $in: numbers },
      status: 'reservado',
      userId,
      timestamp: { $gte: fiveMinutesAgo }
    }).toArray();
    console.log(`[${new Date().toISOString()}] Verificação de reserva para números ${numbers.join(', ')}, userId: ${userId}, válida: ${validNumbers.length === numbers.length}`);
    res.json({ valid: validNumbers.length === numbers.length });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Erro ao verificar reserva:`, error.message);
    res.status(500).json({ valid: false, message: 'Erro ao verificar reserva', details: error.message });
  }
});

// Endpoint para criar preferência de pagamento
app.post('/create_preference', async (req, res) => {
  try {
    const { quantity, buyerName, buyerPhone, numbers, userId } = req.body;
    console.log('Received request body at:', new Date().toISOString(), { quantity, buyerName, buyerPhone, numbers, userId });

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
    if (!userId) {
      console.log('Error: Missing userId');
      return res.status(400).json({ error: 'UserId é obrigatório' });
    }

    // Verify reservation
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    const validNumbers = await db.collection('numbers').find({
      number: { $in: numbers },
      status: 'reservado',
      userId,
      timestamp: { $gte: fiveMinutesAgo }
    }).toArray();
    if (validNumbers.length !== numbers.length) {
      console.error(`[${new Date().toISOString()}] Números não estão reservados para userId: ${userId}`);
      return res.status(400).json({ error: 'Números não estão mais reservados para você' });
    }

    console.log('Creating Mercado Pago preference...');
    const preference = new Preference(mp);
    const preferenceData = {
      body: {
        items: [{
          title: `Rifa - ${quantity} número(s)`,
          quantity: Number(quantity),
          unit_price: 20,
          currency_id: 'BRL'
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

    console.log('Preference data being sent:', JSON.stringify(preferenceData, null, 2));
    const response = await preference.create(preferenceData);
    console.log('Preference created successfully, init_point:', response.init_point, 'Preference ID:', response.id);

    // Save pending purchase
    await db.collection('purchases').insertOne({
      buyerName,
      buyerPhone,
      numbers,
      purchaseDate: new Date(),
      paymentId: null,
      status: 'pending',
      date_approved: null,
      preference_id: response.id,
      userId
    });

    res.json({ init_point: response.init_point, preference_id: response.id });
  } catch (error) {
    console.error('Error in /create_preference at:', new Date().toISOString(), error.message, 'Stack:', error.stack);
    res.status(500).json({ error: 'Erro ao criar preferência', details: error.message });
  }
});

// Endpoint para webhook
app.post('/webhook', async (req, res) => {
  try {
    console.log('Webhook received at:', new Date().toISOString(), 'Method:', req.method, 'Raw Body:', JSON.stringify(req.body, null, 2));
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

    if (paymentId) {
      const payment = new Payment(mp);
      try {
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
            console.error('Erro ao parsear external_reference:', e.message);
            return res.status(200).send('OK');
          }

          const { buyerName, buyerPhone, numbers, userId } = externalReference;
          if (buyerName && buyerPhone && numbers && Array.isArray(numbers) && userId) {
            if (!db) {
              console.error('MongoDB não conectado');
              return res.status(500).send('Erro: MongoDB não conectado');
            }
            const existingPurchase = await db.collection('purchases').findOne({ paymentId: paymentDetails.id });
            if (!existingPurchase) {
              const validNumbers = await db.collection('numbers').find({
                number: { $in: numbers },
                status: 'reservado',
                userId
              }).toArray();
              if (validNumbers.length !== numbers.length) {
                console.error(`[${new Date().toISOString()}] Números não reservados para userId: ${userId}, números: ${numbers.join(', ')}`);
                return res.status(400).json({ error: 'Números não reservados' });
              }

              await db.collection('numbers').updateMany(
                { number: { $in: numbers }, status: 'reservado', userId },
                { $set: { status: 'vendido', userId: null, timestamp: null } }
              );

              await db.collection('purchases').insertOne({
                buyerName,
                buyerPhone,
                numbers,
                purchaseDate: new Date(),
                paymentId: paymentDetails.id,
                status: 'approved',
                date_approved: paymentDetails.date_approved || new Date(),
                preference_id: paymentDetails.preference_id || 'Não encontrado',
                userId
              });
              console.log('Purchase saved successfully for paymentId:', paymentDetails.id, { buyerName, buyerPhone, numbers, status: 'approved' });
            } else {
              console.log('Purchase already exists for paymentId:', paymentDetails.id, 'Skipping duplicate');
            }
          }
        } else {
          // Liberar números se o pagamento não for aprovado
          let externalReference;
          try {
            externalReference = JSON.parse(paymentDetails.external_reference || '{}');
          } catch (e) {
            console.error('Erro ao parsear external_reference:', e.message);
            return res.status(200).send('OK');
          }
          const { numbers, userId } = externalReference;
          if (numbers && Array.isArray(numbers) && userId) {
            await db.collection('numbers').updateMany(
              { number: { $in: numbers }, status: 'reservado', userId },
              { $set: { status: 'disponível', userId: null, timestamp: null } }
            );
            console.log(`[${new Date().toISOString()}] Números ${numbers.join(', ')} liberados devido a status ${paymentDetails.status}`);
            await db.collection('purchases').updateOne(
              { numbers: { $in: numbers }, status: 'pending', userId },
              { $set: { status: paymentDetails.status, date_approved: null } }
            );
          }
        }
      } catch (error) {
        console.error('Erro ao buscar payment details:', error.message);
        return res.status(200).send('OK');
      }
    } else {
      console.log('No valid payment ID found:', JSON.stringify(body, null, 2));
    }
    return res.status(200).send('OK');
  } catch (error) {
    console.error('Erro no webhook:', error.message);
    return res.status(200).send('OK');
  }
});

// Função auxiliar para buscar preference_id
async function getPreferenceIdFromPayment(paymentId) {
  try {
    const payment = new Payment(mp);
    const paymentDetails = await payment.get({ id: paymentId });
    console.log('Payment details for preference_id:', {
      paymentId,
      preference_id: paymentDetails.preference_id || 'Não encontrado',
      status: paymentDetails.status
    });
    return paymentDetails.preference_id || null;
  } catch (error) {
    console.error('Erro ao buscar preference_id:', error.message);
    return null;
  }
}

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

// Endpoint para números premiados
app.get('/winning_numbers', async (req, res) => {
  try {
    if (!db) throw new Error('MongoDB não conectado');
    const winningPrizes = await db.collection('winning_prizes').find().toArray();
    console.log('Números premiados encontrados:', winningPrizes.length);
    const winningNumbers = winningPrizes.map(p => `${p.number}:${p.prize}:${p.instagram ? p.instagram.replace('@', '') : ''}`);
    res.json(winningNumbers);
  } catch (error) {
    console.error('Erro ao buscar números premiados:', error.message);
    res.status(500).json({ error: 'Erro ao buscar números premiados', details: error.message });
  }
});

// Endpoint para verificar compra
app.post('/check_purchase', async (req, res) => {
  try {
    const { numbers, buyerPhone } = req.body;
    if (!numbers || !Array.isArray(numbers) || !buyerPhone) {
      return res.status(400).json({ error: 'Números e telefone são obrigatórios' });
    }

    const purchases = await db.collection('purchases').find().toArray();
    const buyerPurchases = purchases.filter(p => p.buyerPhone === buyerPhone);

    const ownedNumbers = numbers.filter(num => {
      return buyerPurchases.some(p => p.numbers.includes(num));
    });

    const response = {
      owned: ownedNumbers.length > 0,
      buyerName: buyerPurchases.length > 0 ? buyerPurchases[0].buyerName : null,
      numbers: ownedNumbers
    };

    res.json(response);
  } catch (error) {
    console.error('Erro ao verificar compra:', error.message);
    res.status(500).json({ error: 'Erro ao verificar compra', details: error.message });
  }
});

// Endpoint para salvar ganhador
app.post('/save_winner', async (req, res) => {
  try {
    if (!db) throw new Error('MongoDB não conectado');
    const { name, number, phone, prize, instagram } = req.body;
    console.log('Salvando ganhador:', { name, number, phone, prize, instagram });

    if (!number || !phone || !prize) {
      console.log('Erro: Dados incompletos do ganhador');
      return res.status(400).json({ error: 'Dados do ganhador incompletos' });
    }

    const existingWinner = await db.collection('winners').findOne({ number });
    if (existingWinner) {
      console.log('Erro: Número já registrado como ganhador:', number);
      return res.status(400).json({ error: `Número ${number} já registrado como ganhador` });
    }

    const result = await db.collection('winners').insertOne({
      name: name || 'Anônimo',
      number,
      phone,
      prize,
      instagram: instagram || undefined,
      createdAt: new Date()
    });
    console.log('Ganhador salvo com sucesso:', result.insertedId);
    res.status(201).json({ success: true });
  } catch (error) {
    console.error('Erro ao salvar ganhador:', error.message);
    res.status(500).json({ error: 'Erro ao salvar ganhador', details: error.message });
  }
});

// Endpoint para recuperar ganhadores
app.get('/get_winners', async (req, res) => {
  try {
    if (!db) throw new Error('MongoDB não conectado');
    const winners = await db.collection('winners').find().sort({ createdAt: -1 }).toArray();
    console.log('Ganhadores recuperados:', winners.length);
    res.json(winners);
  } catch (error) {
    console.error('Erro ao recuperar ganhadores:', error.message);
    res.status(500).json({ error: 'Erro ao recuperar ganhadores', details: error.message });
  }
});

app.get('/', (req, res) => {
  res.send('API da Rifa está online!');
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT} at ${new Date().toISOString()}`);
});
