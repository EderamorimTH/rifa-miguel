import express from 'express';
import cors from 'cors';
import mercadopago from 'mercadopago';

const app = express();
app.use(cors());
app.use(express.json());

// Configure o Access Token
const mp = new mercadopago.MercadoPago({
  accessToken: process.env.ACCESS_TOKEN_MP
});

app.post('/create_preference', async (req, res) => {
  const { quantity, buyerName, buyerPhone } = req.body;

  try {
    const result = await mp.preferences.create({
      body: {
        items: [
          {
            title: `Rifa Solidária para o Miguel - ${quantity} número(s)`,
            quantity: quantity,
            unit_price: 10
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
      }
    });

    res.json({ init_point: result.body.init_point });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro ao criar preferência de pagamento.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
