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
app.use(express.static(path.join(__dirname, 'public')));

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
    console.log('Verificando senha às: ' + new Date().toISOString());

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
      const filePath = path.join(__dirname, 'public', 'sorteio.html');
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
  } Milano

System: ### Instruções para Implementar a Correção

1. **Atualizar o Backend (`index.js`)**:
   - Substitua o arquivo `index.js` no seu projeto no Render pelo código fornecido no artefato acima (ID: `8c1a3252-da81-481a-ab4a-5473368cc59f`).
   - Certifique-se de que o arquivo `sorteio.html` está no diretório `public` do seu projeto no Render.
   - No painel do Render, vá para **Environment Variables** e adicione ou verifique se a variável `SORTEIO_PASSWORD` está definida como `VAIDACERTO`.

2. **Atualizar o Frontend (`index.html`)**:
   - Substitua o arquivo `index.html` no seu repositório (ex.: `ederamorimth.github.io`) pelo código fornecido no artefato anterior (ID: `db24f4bd-f32b-4831-9ba0-296e41464b17`).
   - Isso atualiza a função `checkPassword` para usar a rota `/verify_password` antes de redirecionar, melhorando a experiência do usuário e o tratamento de erros.

3. **Verificações no Render**:
   - Confirme que o diretório `public` contém o arquivo `sorteio.html` e que ele está acessível.
   - Verifique os logs no Render (seção **Logs** no painel) para identificar possíveis erros, como falhas na entrega do arquivo ou problemas de conexão com o MongoDB.
   - Se o erro persistir, aumente o timeout do servidor no Render ajustando as configurações de escalabilidade ou contate o suporte do Render para verificar possíveis limitações de rede.

4. **Testar a Solução**:
   - Acesse a página principal (ex.: `https://ederamorimth.github.io/rifa-miguel/index.html`).
   - Clique no botão "Sorteio" na navegação e insira a senha `VAIDACERTO`.
   - O sistema deve validar a senha via `/verify_password` e redirecionar para `https://rifa-miguel.onrender.com/sorteio`, exibindo a página `sorteio.html`.

### Explicação das Mudanças
- **Backend (`index.js`)**: A rota `/sorteio` agora retorna respostas JSON claras para erros (ex.: senha incorreta ou arquivo não encontrado), facilitando a depuração. O uso de `res.sendFile` com callback de erro garante que falhas no acesso ao arquivo `sorteio.html` sejam tratadas adequadamente.
- **Frontend (`index.html`)**: A função `checkPassword` faz uma chamada assíncrona à rota `/verify_password` e só redireciona se a senha for válida, exibindo mensagens de erro claras para o usuário em caso de falha.
- **Render**: A configuração correta da variável `SORTEIO_PASSWORD` e do diretório `public` elimina problemas de ambiente, enquanto os logs ajudam a diagnosticar variações, como timeouts ou erros de CORS.

### Resolução do Erro "Cannot GET /sorteio"
O erro ocorre porque o Render não conseguiu servir o arquivo `sorteio.html` ou a senha não foi validada corretamente. As mudanças acima garantem que:
- A senha é verificada de forma robusta.
- O arquivo `sorteio.html` é servido com tratamento de erro.
- O frontend lida com falhas de forma amigável, evitando redirecionamentos diretos que podem falhar devido a variações no Render.

Se o erro persistir após essas alterações, verifique os logs do Render para detalhes específicos (ex.: arquivo `sorteio.html` não encontrado ou timeout de rede) e compartilhe-os para análise adicional.
