const express = require("express");
const cors = require("cors");
const https = require("https");
const crypto = require("crypto");
require("dotenv").config();

// Main checkout site after YooKassa payment (used if PUBLIC_ORIGIN is not set on Render).
const DEFAULT_PUBLIC_ORIGIN = "https://lisanalarab-web.onrender.com";

const app = express();

// Explicit CORS so browsers always get ACAO on preflight and POST (checkout page is another origin).
app.use(
  cors({
    origin: "*",
    methods: ["GET", "HEAD", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Accept"],
    maxAge: 86400,
  })
);
app.options("/create-payment", (_req, res) => res.sendStatus(204));

app.use(express.json());

// Health check: use in Render "Health Check Path" (/), or open in browser to confirm the Web Service is up.
app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "lisanalarab-backend",
    createPayment: "POST /create-payment",
  });
});

// Shop ID is public; prefer YOOKASSA_SHOP_ID on Render. Default matches your YooKassa shop.
const SHOP_ID = String(process.env.YOOKASSA_SHOP_ID || "1347048").trim();
// Secret key must ONLY be set via environment (Render dashboard or local .env — never commit it).
const SECRET_KEY =
  process.env.YOOKASSA_SECRET_KEY &&
  String(process.env.YOOKASSA_SECRET_KEY).trim();

const FIREBASE_WEB_API_KEY =
  process.env.FIREBASE_WEB_API_KEY &&
  String(process.env.FIREBASE_WEB_API_KEY).trim();

/**
 * HTTPS POST to YooKassa Payments API (no third-party npm SDK — avoids missing/404 packages on npm).
 */
function normalizeEmail(raw) {
  if (raw == null || raw === "") return "";
  return String(raw).trim().toLowerCase();
}

/**
 * Verify email/password against Firebase Auth (same users as the iOS app) via Identity Toolkit REST API.
 * Uses FIREBASE_WEB_API_KEY — same value as API_KEY in GoogleService-Info.plist for the project.
 */
function firebaseSignInWithPassword(apiKey, email, password) {
  const payload = JSON.stringify({
    email,
    password,
    returnSecureToken: true,
  });
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "identitytoolkit.googleapis.com",
        path: `/v1/accounts:signInWithPassword?key=${encodeURIComponent(apiKey)}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload, "utf8"),
        },
      },
      (authRes) => {
        let raw = "";
        authRes.on("data", (chunk) => {
          raw += chunk;
        });
        authRes.on("end", () => {
          let parsed = {};
          try {
            parsed = raw ? JSON.parse(raw) : {};
          } catch {
            parsed = {};
          }
          if (
            authRes.statusCode >= 200 &&
            authRes.statusCode < 300 &&
            parsed.idToken
          ) {
            resolve(parsed);
            return;
          }
          reject(
            Object.assign(new Error(parsed.error?.message || "auth_failed"), {
              firebaseMessage: parsed.error?.message,
            })
          );
        });
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function yooKassaPostPayment(idempotenceKey, authorization, bodyStr) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "api.yookassa.ru",
        path: "/v3/payments",
        method: "POST",
        headers: {
          Authorization: authorization,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(bodyStr, "utf8"),
          "Idempotence-Key": idempotenceKey,
        },
      },
      (ykRes) => {
        let raw = "";
        ykRes.on("data", (chunk) => {
          raw += chunk;
        });
        ykRes.on("end", () => {
          resolve({ statusCode: ykRes.statusCode, raw });
        });
      }
    );
    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

app.post("/create-payment", async (req, res) => {
  try {
    const publicOrigin = String(
      (process.env.PUBLIC_ORIGIN && process.env.PUBLIC_ORIGIN.trim()) ||
        DEFAULT_PUBLIC_ORIGIN
    ).replace(/\/$/, "");
    if (!SECRET_KEY) {
      return res.status(500).json({
        error: "missing_env",
        description: "Set YOOKASSA_SECRET_KEY on Render.",
      });
    }

    if (!FIREBASE_WEB_API_KEY) {
      return res.status(500).json({
        error: "missing_firebase_config",
        description:
          "Set FIREBASE_WEB_API_KEY on Render (Firebase Console → Project settings → Web API key, same project as the mobile app GoogleService-Info.plist API_KEY).",
      });
    }

    const email = normalizeEmail(req.body && req.body.email);
    const password = String((req.body && req.body.password) || "");

    if (!email || !password) {
      return res.status(400).json({
        error: "invalid_body",
        description:
          "Укажите электронную почту и пароль — те же, что в приложении «Лисан аль‑Араб».",
      });
    }

    try {
      await firebaseSignInWithPassword(FIREBASE_WEB_API_KEY, email, password);
    } catch {
      return res.status(401).json({
        error: "invalid_credentials",
        description:
          "Неверная почта или пароль. Введите те же данные, что используете для входа в приложении.",
      });
    }

    // After payment YooKassa redirects here; open_app=1 lets the checkout page try the custom URL scheme for the iOS app.
    const returnUrl = `${publicOrigin}/?vip_return=1&open_app=1`;
    const paymentPayload = {
      amount: { value: "1000.00", currency: "RUB" },
      capture: true,
      confirmation: {
        type: "redirect",
        return_url: returnUrl,
      },
      description: "Lisan Al-Arab Course Payment",
    };

    const bodyStr = JSON.stringify(paymentPayload);
    const auth =
      "Basic " +
      Buffer.from(`${SHOP_ID}:${SECRET_KEY}`, "utf8").toString("base64");

    const { statusCode, raw } = await yooKassaPostPayment(
      crypto.randomUUID(),
      auth,
      bodyStr
    );

    let parsed = {};
    try {
      parsed = raw ? JSON.parse(raw) : {};
    } catch {
      parsed = { description: raw ? String(raw).slice(0, 200) : "empty body" };
    }

    const confirmationUrl =
      parsed.confirmation && parsed.confirmation.confirmation_url;

    if (statusCode >= 200 && statusCode < 300 && confirmationUrl) {
      console.log("Payment created:", parsed.id, "for", email);
      return res.json({
        confirmation_url: confirmationUrl,
        confirmation: {
          type: "redirect",
          confirmation_url: confirmationUrl,
        },
        customer_email: email,
      });
    }

    const message =
      parsed.description ||
      parsed.type ||
      (typeof parsed === "string" ? parsed : "yookassa_error");
    return res.status(statusCode >= 400 ? statusCode : 502).json({
      error: parsed.type || "payment_failed",
      description: message,
      details: parsed,
    });
  } catch (error) {
    console.error("YooKassa Error:", error);
    return res.status(500).json({ error: error.message || String(error) });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Backend server is running on port ${PORT}`);
});
