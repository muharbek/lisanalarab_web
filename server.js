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
app.options("/verify-vip-payment", (_req, res) => res.sendStatus(204));

app.use(express.json());

// Health check: use in Render "Health Check Path" (/), or open in browser to confirm the Web Service is up.
app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "lisanalarab-backend",
    createPayment: "POST /create-payment",
    verifyPayment: "POST /verify-vip-payment",
  });
});

// Shop ID is public; prefer YOOKASSA_SHOP_ID on Render. Default matches your YooKassa shop.
const SHOP_ID = String(process.env.YOOKASSA_SHOP_ID || "1347048").trim();
// Secret key must ONLY be set via environment (Render dashboard or local .env — never commit it).
const SECRET_KEY =
  process.env.YOOKASSA_SECRET_KEY &&
  String(process.env.YOOKASSA_SECRET_KEY).trim();

const FIREBASE_WEB_API_KEY =
  (process.env.FIREBASE_WEB_API_KEY &&
    String(process.env.FIREBASE_WEB_API_KEY).trim()) ||
  // Fallback from the same Firebase project used by the mobile app (GoogleService-Info.plist API_KEY).
  "AIzaSyC7Tk1r7sc1432lml3qKifAJDo4xa8DrlY";

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

function yooKassaAuthHeader() {
  if (!SECRET_KEY) return null;
  return (
    "Basic " +
    Buffer.from(`${SHOP_ID}:${SECRET_KEY}`, "utf8").toString("base64")
  );
}

function yooKassaGetPayment(paymentId, authorization) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "api.yookassa.ru",
        path: `/v3/payments/${encodeURIComponent(paymentId)}`,
        method: "GET",
        headers: {
          Authorization: authorization,
          "Content-Type": "application/json",
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
      amount: { value: "150.00", currency: "RUB" },
      capture: true,
      confirmation: {
        type: "redirect",
        return_url: returnUrl,
      },
      description: "Lisan Al-Arab Course Payment",
      metadata: {
        customer_email: email,
        source: "lisan_web_checkout",
      },
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
        yookassa_payment_id: parsed.id,
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

/**
 * After redirect from YooKassa: verify payment status via API so we only show VIP success when really paid.
 */
app.post("/verify-vip-payment", async (req, res) => {
  try {
    const authHeader = yooKassaAuthHeader();
    if (!authHeader) {
      return res.status(500).json({
        error: "missing_env",
        description: "Set YOOKASSA_SECRET_KEY on Render.",
      });
    }

    const email = normalizeEmail(req.body && req.body.email);
    const password = String((req.body && req.body.password) || "");
    const paymentId = String((req.body && req.body.payment_id) || "").trim();

    if (!email || !password || !paymentId) {
      return res.status(400).json({
        error: "invalid_body",
        description:
          "Нужны email, password и payment_id для проверки статуса платежа.",
      });
    }

    try {
      await firebaseSignInWithPassword(FIREBASE_WEB_API_KEY, email, password);
    } catch {
      return res.status(401).json({
        error: "invalid_credentials",
        description:
          "Неверная почта или пароль. Введите те же данные, что в приложении.",
      });
    }

    const { statusCode, raw } = await yooKassaGetPayment(paymentId, authHeader);
    let payment = {};
    try {
      payment = raw ? JSON.parse(raw) : {};
    } catch {
      payment = {};
    }

    if (statusCode < 200 || statusCode >= 300) {
      return res.status(200).json({
        verified: false,
        payment_status: null,
        description:
          "Не удалось получить статус платежа в YooKassa. Попробуйте позже.",
      });
    }

    const status = payment.status || "";
    const metaEmail = normalizeEmail(
      payment.metadata && payment.metadata.customer_email
    );
    if (metaEmail && metaEmail !== email) {
      return res.status(200).json({
        verified: false,
        payment_status: status,
        description:
          "Этот платёж привязан к другой почте. Войдите с правильным аккаунтом.",
      });
    }

    if (status === "succeeded") {
      return res.json({
        verified: true,
        payment_status: status,
        description:
          "Вы активировали VIP. Полный доступ включён — откройте приложение с этой же почтой.",
      });
    }

    if (status === "pending" || status === "waiting_for_capture") {
      return res.json({
        verified: false,
        payment_status: status,
        description:
          "Платёж ещё обрабатывается. Обновите страницу через минуту или откройте приложение позже.",
      });
    }

    return res.json({
      verified: false,
      payment_status: status || "unknown",
      description:
        "Оплата не завершена или отменена. Если списали деньги — подождите несколько минут и обновите страницу.",
    });
  } catch (error) {
    console.error("verify-vip-payment:", error);
    return res.status(500).json({ error: error.message || String(error) });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Backend server is running on port ${PORT}`);
});
