const express = require('express');
const cors = require('cors');
const mercadopago = require('mercadopago');

const app = express();
app.use(cors());
app.use(express.json());

// Crie uma instância do Mercado Pago
const mp = new mercadopago.MercadoPago({
  access_token: process.env.ACCESS_TOKEN_MP
});

// Rota para criar a preferência de pagamento
app.post('/create_preference', async (req, res) => {
  const { quantity, buyerName, buyerPhone } = req.body;

  try {
    const preference = {
      items: [
        {
          title: `Rifa Solidária para o Miguel - ${quantity} número(s)`,
          unit_price: 10,
          quantity: quantity
        }
      ],
      payer: {
        name: buyerName,
        phone: {
          number: buyerPhone
        }
      },
      back_urls: {
        success: "https://seusite.com/sucesso",
        failure: "https://seusite.com/erro",
        pending: "https://seusite.com/pendente"
      },
      auto_return: "approved"
    };

    const result = await mp.preferences.create({ body: preference });
    res.json({ init_point: result.init_point });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erro ao criar preferência" });
  }
});

// Porta do servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
