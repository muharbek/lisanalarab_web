const express = require('express');
const cors = require('cors');
const YooKassa = require('yookassa-node-sdk');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Инициализация с твоим Shop ID
const checkout = new YooKassa({ 
    shopId: '445946', 
    secretKey: process.env.YOOKASSA_SECRET_KEY 
});

app.post('/create-payment', async (req, res) => {
    try {
        const payment = await checkout.createPayment({
            amount: {
                value: '1000.00',
                currency: 'RUB'
            },
            payment_method_data: {
                type: 'bank_card'
            },
            confirmation: {
                type: 'redirect',
                return_url: process.env.PUBLIC_ORIGIN || 'https://lisanalarab-web.onrender.com'
            },
            description: 'Lisan Al-Arab Course Payment',
            capture: true
        });
        
        console.log('Payment created:', payment.id);
        res.json({ confirmation_url: payment.confirmation.confirmation_url });
    } catch (error) {
        console.error('YooKassa Error:', error);
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`Backend server is running on port ${PORT}`);
});