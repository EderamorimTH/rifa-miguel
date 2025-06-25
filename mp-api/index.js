const express = require('express');
const mercadopago = require('mercadopago');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Coloque aqui seu Access Token do Mercado Pago
mercadopago.configure({
  access_token: process.env.ACCESS_TOKEN_MP
});

app.post('/create_preference', async (req, res) => {
  const { quantity, buyerName, buyerPhone } = req.body;

  const preference = {
    items: [
      {
        title: `Rifa para Miguel - ${buyerName}`,
        quantity: quantity,
        unit_price: 10
      }
    ],
    back_urls: {
      success: 'https://seusite.com/sucesso',
      failure: 'https://seusite.com/falha',
      pending: 'https://seusite.com/pendente'
    },
    auto_return: 'approved'
  };

  try {
    const response = await mercadopago.preferences.create(preference);
    res.json({ init_point: response.body.init_point });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro ao criar preferência' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`API rodando na porta ${PORT}`);
});
