import express from 'express';
import cors from 'cors';
import mercadopago from 'mercadopago';

const app = express();
app.use(cors());
app.use(express.json());

const mp = new mercadopago.MercadoPago(process.env.ACCESS_TOKEN_MP);

app.get('/', (req, res) => {
  res.send('API da Rifa está online!');
});

app.post('/create_preference', async (req, res) => {
  try {
    const { quantity, buyerName, buyerPhone } = req.body;

    const preference = {
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
        success: "https://seusite.com/sucesso",
        failure: "https://seusite.com/erro",
        pending: "https://seusite.com/pendente"
      },
      auto_return: "approved"
    };

    const response = await mp.preferences.create(preference);

    res.json({ init_point: response.body.init_point });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro ao criar preferência' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
