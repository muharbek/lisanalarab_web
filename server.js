const express = require("express");
const cors = require("cors");
const { YooCheckout } = require("yookassa-sdk-v3");
require("dotenv").config();

const app = express();

// Allow cross-origin requests from your static checkout page (e.g. Netlify / Render static).
app.use(cors());
app.use(express.json());

// YooKassa client: never commit secretKey; set YOOKASSA_SECRET_KEY in Render (or .env locally).
const checkout = new YooCheckout({
  shopId: "445946",
  secretKey: process.env.YOOKASSA_SECRET_KEY,
});

/**
 * Creates a payment and returns the redirect URL for the YooKassa hosted payment page.
 * Body is accepted for forward compatibility; amount is fixed in this handler.
 */
app.post("/create-payment", async (req, res) => {
  try {
    const payment = await checkout.createPayment({
      amount: {
        value: "1000.00",
        currency: "RUB",
      },
      payment_method_data: {
        type: "bank_card",
      },
      confirmation: {
        type: "redirect",
        // Where the user returns after paying; should be your public HTTPS checkout site.
        return_url: process.env.PUBLIC_ORIGIN || "https://lisanalarab-web.onrender.com",
      },
      description: "Lisan Al-Arab Course Payment",
      capture: true,
    });

    res.json({ confirmation_url: payment.confirmation.confirmation_url });
  } catch (error) {
    console.error("YooKassa Error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Render (and many hosts) set PORT; 10000 matches your local default.
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Backend server is running on port ${PORT}`);
});
