```javascript
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');

const app = express();
const port = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

const client = new MercadoPagoConfig({ accessToken: process.env.ACCESS_TOKEN_MP });

// Conexão com o MongoDB
let db;
async function connectToMongoDB() {
    try {
        await mongoose.connect(process.env.MONGODB_URI, {
            useNewUrlParser: true,
            useUnifiedTopology: true,
        });
        console.log(`[${new Date().toISOString()}] Conectado ao MongoDB!`);
        db = mongoose.connection.db; // Armazena a referência ao banco
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Erro ao conectar ao MongoDB:`, error);
        process.exit(1);
    }
}

// Schema para números
const numberSchema = new mongoose.Schema({
    number: { type: String, required: true, unique: true },
    status: { type: String, enum: ['disponível', 'reservado', 'vendido'], default: 'disponível' },
    userId: { type: String, default: null },
    timestamp: { type: Date, default: null },
});
const Comprador = mongoose.model('Number', numberSchema, 'numbers');

// Schema para compras
const purchaseSchema = new mongoose.Schema({
    buyerName: String,
    buyerPhone: String,
    numbers: [String],
    purchaseDate: { type: Date, default: Date.now },
    paymentId: String,
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
    date_approved: Date,
    preference_id: String,
    userId: String,
});
const Purchase = mongoose.model('Purchase', purchaseSchema, 'purchases');

// Inicializar números no banco
async function initializeNumbers() {
    try {
        const count = await Comprador.countDocuments();
        if (count === 0) {
            const numbers = Array.from({ length: 900 }, (_, i) => ({
                number: String(i + 1).padStart(4, '0'),
                status: 'disponível',
            }));
            await Comprador.insertMany(numbers);
            console.log(`[${new Date().toISOString()}] 900 números inicializados.`);
        } else {
            console.log(`[${new Date().toISOString()}] Coleção numbers já contém ${count} documentos.`);
        }
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Erro ao inicializar números:`, error);
    }
}

// Função para liberar reservas expiradas
async function releaseExpiredReservations() {
    if (!db) {
        console.error(`[${new Date().toISOString()}] Banco de dados não inicializado para liberar reservas`);
        return;
    }
    try {
        const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
        const result = await Comprador.updateMany(
            { status: 'reservado', timestamp: { $lt: fiveMinutesAgo } },
            { $set: { status: 'disponível', userId: null, timestamp: null } }
        );
        if (result.modifiedCount > 0) {
            console.log(`[${new Date().toISOString()}] ${result.modifiedCount} reservas expiradas liberadas.`);
        }
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Erro ao liberar reservas expiradas:`, error);
    }
}

// Executar liberação de reservas a cada minuto
setInterval(async () => {
    if (db) {
        await releaseExpiredReservations();
    }
}, 60 * 1000);

// Inicializar servidor
async function startServer() {
    await connectToMongoDB();
    await initializeNumbers();
    await releaseExpiredReservations(); // Executa imediatamente após inicialização
    app.listen(port, () => {
        console.log(`[${new Date().toISOString()}] Servidor rodando na porta ${port}`);
    });
}

startServer();

// Endpoint para números disponíveis
app.get('/available_numbers', async (req, res) => {
    try {
        const numbers = await Comprador.find({ status: 'disponível' }).select('number');
        res.json(numbers.map(n => n.number));
        console.log(`[${new Date().toISOString()}] Números disponíveis retornados: ${numbers.length}`);
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Erro ao obter números disponíveis:`, error);
        res.status(500).json({ error: 'Erro ao carregar números disponíveis' });
    }
});

// Endpoint para progresso
app.get('/progress', async (req, res) => {
    try {
        const total = 900;
        const sold = await Comprador.countDocuments({ status: 'vendido' });
        const progress = (sold / total) * 100;
        res.json({ progress });
        console.log(`[${new Date().toISOString()}] Progresso: ${progress.toFixed(2)}% (${sold}/${total})`);
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Erro ao calcular progresso:`, error);
        res.status(500).json({ error: 'Erro ao calcular progresso' });
    }
});

// Endpoint para reservar números
app.post('/reserve_numbers', async (req, res) => {
    const { numbers, userId } = req.body;
    console.log(`[${new Date().toISOString()}] Recebendo solicitação para reservar números: ${numbers}, userId: ${userId}`);
    try {
        const session = await mongoose.startSession();
        session.startTransaction();
        try {
            const availableNumbers = await Comprador.find({
                number: { $in: numbers },
                status: 'disponível',
            }).session(session);
            if (availableNumbers.length !== numbers.length) {
                await session.abortTransaction();
                console.log(`[${new Date().toISOString()}] Alguns números não estão disponíveis: ${numbers}`);
                return res.status(400).json({ success: false, message: 'Alguns números não estão disponíveis' });
            }

            await Comprador.updateMany(
                { number: { $in: numbers } },
                { $set: { status: 'reservado', userId, timestamp: new Date() } },
                { session }
            );
            await session.commitTransaction();
            console.log(`[${new Date().toISOString()}] Números ${numbers.join(', ')} reservados com sucesso para userId: ${userId}`);
            res.json({ success: true });
        } catch (error) {
            await session.abortTransaction();
            throw error;
        } finally {
            session.endSession();
        }
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Erro ao reservar números:`, error);
        res.status(500).json({ success: false, message: 'Erro ao reservar números' });
    }
});

// Endpoint para verificar reserva
app.post('/check_reservation', async (req, res) => {
    const { numbers, userId } = req.body;
    console.log(`[${new Date().toISOString()}] Verificação de reserva para números ${numbers}, userId: ${userId}`);
    try {
        const validNumbers = await Comprador.find({
            number: { $in: numbers },
            status: 'reservado',
            userId,
        });
        const isValid = validNumbers.length === numbers.length;
        console.log(`[${new Date().toISOString()}] Verificação de reserva para números ${numbers}, userId: ${userId}, válida: ${isValid}`);
        res.json({ valid: isValid });
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Erro ao verificar reserva:`, error);
        res.status(500).json({ valid: false, message: 'Erro ao verificar reserva' });
    }
});

// Endpoint para criar preferência de pagamento
app.post('/create_preference', async (req, res) => {
    console.log(`Received request body at: ${new Date().toISOString()}`, req.body);
    try {
        const { quantity, buyerName, buyerPhone, numbers, userId } = req.body;
        if (!quantity || !buyerName || !buyerPhone || !numbers || numbers.length === 0) {
            console.log(`[${new Date().toISOString()}] Dados incompletos recebidos:`, req.body);
            return res.status(400).json({ error: 'Dados incompletos' });
        }

        const preference = new Preference(client);
        console.log(`Creating Mercado Pago preference...`);
        const preferenceData = {
            body: {
                items: [
                    {
                        title: `Rifa - ${quantity} número(s)`,
                        quantity: 1,
                        unit_price: quantity * 20,
                        currency_id: 'BRL',
                    },
                ],
                payer: {
                    name: buyerName,
                    phone: { number: buyerPhone },
                },
                back_urls: {
                    success: 'https://ederamorimth.github.io/rifa-miguel/sucesso.html',
                    failure: 'https://ederamorimth.github.io/rifa-miguel/erro.html',
                    pending: 'https://ederamorimth.github.io/rifa-miguel/pendente.html',
                },
                auto_return: 'approved',
                external_reference: JSON.stringify({ buyerName, buyerPhone, numbers, userId }),
                notification_url: 'https://rifa-miguel.onrender.com/webhook',
            },
        };
        console.log(`Preference data being sent:`, preferenceData);
        const response = await preference.create(preferenceData);
        console.log(`Preference created successfully, init_point: ${response.init_point} Preference ID: ${response.id}`);

        const session = await mongoose.startSession();
        session.startTransaction();
        try {
            await Purchase.create(
                [{
                    buyerName,
                    buyerPhone,
                    numbers,
                    purchaseDate: new Date(),
                    paymentId: null,
                    status: 'pending',
                    preference_id: response.id,
                    userId,
                }],
                { session }
            );
            await session.commitTransaction();
            console.log(`[${new Date().toISOString()}] Compra salva como pendente para números: ${numbers.join(', ')}`);
        } catch (error) {
            await session.abortTransaction();
            console.error(`[${new Date().toISOString()}] Erro ao salvar compra pendente:`, error);
            return res.status(500).json({ error: 'Erro ao salvar compra pendente' });
        } finally {
            session.endSession();
        }

        res.json({ init_point: response.init_point });
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Erro ao criar preferência:`, error);
        res.status(500).json({ error: 'Erro ao criar o pagamento' });
    }
});

// Endpoint para verificar compra
app.post('/check_purchase', async (req, res) => {
    const { numbers, buyerPhone } = req.body;
    try {
        const purchase = await Purchase.findOne({
            numbers: { $in: numbers },
            buyerPhone,
            status: 'approved',
        });
        if (purchase) {
            res.json({ owned: true, buyerName: purchase.buyerName, numbers: purchase.numbers });
        } else {
            res.json({ owned: false });
        }
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Erro ao verificar compra:`, error);
        res.status(500).json({ error: 'Erro ao verificar compra' });
    }
});

// Webhook para notificações do Mercado Pago
app.post('/webhook', async (req, res) => {
    const payment = req.body;
    console.log(`Webhook received at: ${new Date().toISOString()} Method: ${req.method} Raw Body:`, JSON.stringify(payment, null, 2));
    try {
        if (payment.type === 'payment' && payment.data && payment.data.id) {
            const paymentId = payment.data.id;
            const paymentClient = new Payment(client);
            const paymentDetails = await paymentClient.get({ id: paymentId });
            console.log(`Payment details:`, {
                id: paymentDetails.id,
                status: paymentDetails.status,
                preference_id: paymentDetails.preference_id || 'Não encontrado',
                external_reference: paymentDetails.external_reference || 'Não encontrado',
                transaction_amount: paymentDetails.transaction_amount,
                date_approved: paymentDetails.date_approved || 'Não aprovado ainda',
            });

            let externalReference;
            try {
                externalReference = JSON.parse(paymentDetails.external_reference || '{}');
            } catch (e) {
                console.error(`[${new Date().toISOString()}] Erro ao parsear external_reference:`, e);
                return res.sendStatus(400);
            }
            const { numbers, userId, buyerName, buyerPhone } = externalReference;

            if (!numbers || !userId) {
                console.error(`[${new Date().toISOString()}] Dados inválidos no external_reference:`, externalReference);
                return res.sendStatus(400);
            }

            const session = await mongoose.startSession();
            session.startTransaction();
            try {
                if (paymentDetails.status === 'approved') {
                    // Verificar se a compra existe no banco
                    const purchase = await Purchase.findOne({
                        numbers: { $in: numbers },
                        userId,
                        status: 'pending',
                    }).session(session);

                    if (!purchase) {
                        console.error(`[${new Date().toISOString()}] Compra não encontrada para números: ${numbers.join(', ')}, userId: ${userId}`);
                        await session.abortTransaction();
                        return res.sendStatus(400);
                    }

                    // Atualizar números para 'vendido'
                    const compradorResult = await Comprador.updateMany(
                        { number: { $in: numbers }, userId },
                        { $set: { status: 'vendido', userId: null, timestamp: null } },
                        { session }
                    );
                    console.log(`[${new Date().toISOString()}] Compradores atualizados: ${compradorResult.modifiedCount}`);

                    // Atualizar compra para 'approved'
                    const purchaseResult = await Purchase.updateMany(
                        { numbers: { $in: numbers }, userId, status: 'pending' },
                        { $set: { status: 'approved', paymentId, date_approved: new Date(paymentDetails.date_approved) } },
                        { session }
                    );
                    console.log(`[${new Date().toISOString()}] Compras atualizadas: ${purchaseResult.modifiedCount}`);

                    await session.commitTransaction();
                    console.log(`[${new Date().toISOString()}] Pagamento ${paymentId} aprovado. Números ${numbers.join(', ')} marcados como vendido.`);
                } else if (paymentDetails.status === 'pending') {
                    // Não liberar números imediatamente; esperar 5 minutos via releaseExpiredReservations
                    console.log(`[${new Date().toISOString()}] Pagamento ${paymentId} pendente. Aguardando liberação automática após 5 minutos.`);
                } else {
                    // Liberar números para outros status (rejected, cancelled, etc.)
                    const compradorResult = await Comprador.updateMany(
                        { number: { $in: numbers }, status: 'reservado', userId },
                        { $set: { status: 'disponível', userId: null, timestamp: null } },
                        { session }
                    );
                    console.log(`[${new Date().toISOString()}] Números ${numbers.join(', ')} liberados devido a status ${paymentDetails.status}`);
                    await session.commitTransaction();
                }
            } catch (error) {
                await session.abortTransaction();
                console.error(`[${new Date().toISOString()}] Erro no processamento do webhook:`, error);
                return res.sendStatus(500);
            } finally {
                session.endSession();
            }
        } else {
            console.log(`[${new Date().toISOString()}] Webhook ignorado: tipo ${payment.type || 'desconhecido'}`);
        }
        res.sendStatus(200);
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Erro no webhook:`, error);
        res.sendStatus(500);
    }
});

// Endpoint para resetar números (protegido por senha)
app.post('/reset_numbers', async (req, res) => {
    const { password } = req.body;
    if (password !== process.env.SORTEIO_PASSWORD) {
        console.log(`[${new Date().toISOString()}] Tentativa de reset com senha inválida`);
        return res.status(403).json({ error: 'Senha inválida' });
    }
    try {
        const session = await mongoose.startSession();
        session.startTransaction();
        try {
            await Comprador.deleteMany({}).session(session);
            await Purchase.deleteMany({}).session(session);
            await initializeNumbers();
            await session.commitTransaction();
            console.log(`[${new Date().toISOString()}] Números resetados com sucesso`);
            res.json({ success: true });
        } catch (error) {
            await session.abortTransaction();
            throw error;
        } finally {
            session.endSession();
        }
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Erro ao resetar números:`, error);
        res.status(500).json({ error: 'Erro ao resetar números' });
    }
});

// Endpoint para testar conexão com o banco
app.get('/test_db', async (req, res) => {
    try {
        await mongoose.connection.db.admin().ping();
        res.json({ status: 'Conexão com o banco de dados OK' });
        console.log(`[${new Date().toISOString()}] Teste de conexão com o banco bem-sucedido`);
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Erro no teste de conexão com o banco:`, error);
        res.status(500).json({ error: 'Erro na conexão com o banco de dados' });
    }
});
```
