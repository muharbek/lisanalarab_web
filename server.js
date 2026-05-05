const express = require("express");
const cors = require("cors");
const https = require("https");
const crypto = require("crypto");
const ipRangeCheck = require("ip-range-check");
const admin = require("firebase-admin");
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
app.options("/yookassa-webhook", (_req, res) => res.sendStatus(204));

app.use(express.json());

// Health check: use in Render "Health Check Path" (/), or open in browser to confirm the Web Service is up.
app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "lisanalarab-backend",
    createPayment: "POST /create-payment",
    verifyPayment: "POST /verify-vip-payment",
    yookassaWebhook: "POST /yookassa-webhook",
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

const YOOKASSA_WEBHOOK_CIDRS = [
  "185.71.76.0/27",
  "185.71.77.0/27",
  "77.75.153.0/25",
  "77.75.154.128/25",
  "77.75.156.11/32",
  "77.75.156.35/32",
  "2a02:5180::/32",
];

/**
 * HTTPS POST to YooKassa Payments API (no third-party npm SDK — avoids missing/404 packages on npm).
 */
function normalizeEmail(raw) {
  if (raw == null || raw === "") return "";
  return String(raw).trim().toLowerCase();
}

function parseServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw || !String(raw).trim()) return null;
  const t = String(raw).trim();
  try {
    if (t.startsWith("{")) return JSON.parse(t);
    return JSON.parse(Buffer.from(t, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function ensureAdmin() {
  if (admin.apps.length) return;
  const json = parseServiceAccount();
  if (!json) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON not set");
  }
  admin.initializeApp({ credential: admin.credential.cert(json) });
}

function pendingDocId(email) {
  return Buffer.from(email, "utf8")
    .toString("base64")
    .replace(/\//g, "_")
    .replace(/\+/g, "-");
}

function clientIpFromReq(req) {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length) return xff.split(",")[0].trim();
  const src =
    req.headers["client-ip"] || req.socket?.remoteAddress || req.ip || "";
  return String(src).replace(/^::ffff:/, "");
}

function isYooKassaIp(req) {
  if (process.env.SKIP_YOOKASSA_WEBHOOK_IP_CHECK === "1") return true;
  const ip = clientIpFromReq(req);
  return YOOKASSA_WEBHOOK_CIDRS.some((cidr) => {
    try {
      return ipRangeCheck(ip, cidr);
    } catch {
      return false;
    }
  });
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

    // After payment YooKassa returns user to the website.
    const returnUrl = `${publicOrigin}/?vip_return=1`;
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

/**
 * YooKassa webhook: grants VIP in Firestore ONLY after confirmed payment.succeeded.
 * It writes users/{uid}.is_vip=true for the exact paid email from payment metadata.
 */
app.post("/yookassa-webhook", async (req, res) => {
  try {
    if (!isYooKassaIp(req)) {
      return res.status(403).send("forbidden");
    }
    const authHeader = yooKassaAuthHeader();
    if (!authHeader) {
      return res.status(503).send("no secret");
    }

    const body = req.body && typeof req.body === "object" ? req.body : null;
    if (!body || body.type !== "notification") {
      return res.status(400).send("bad payload");
    }
    if (body.event !== "payment.succeeded") {
      return res.status(200).send("ok");
    }

    const paymentId = body.object && body.object.id;
    if (!paymentId) {
      return res.status(400).send("no id");
    }

    const { statusCode, raw } = await yooKassaGetPayment(paymentId, authHeader);
    if (statusCode < 200 || statusCode >= 300) {
      return res.status(502).send("yk get failed");
    }

    let payment = {};
    try {
      payment = raw ? JSON.parse(raw) : {};
    } catch {
      payment = {};
    }

    if (payment.status !== "succeeded" || payment.paid !== true) {
      return res.status(400).send("not paid");
    }

    const email = normalizeEmail(payment.metadata && payment.metadata.customer_email);
    if (!email) {
      return res.status(200).send("no email metadata");
    }

    ensureAdmin();
    const db = admin.firestore();
    const processedRef = db.collection("yookassa_processed_payments").doc(paymentId);
    const already = await processedRef.get();
    if (already.exists) {
      return res.status(200).send("duplicate");
    }

    try {
      const user = await admin.auth().getUserByEmail(email);
      const batch = db.batch();
      batch.set(
        db.collection("users").doc(user.uid),
        {
          is_vip: true,
          vip_purchase_email: email,
          vip_updated_at: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      batch.set(processedRef, {
        email,
        uid: user.uid,
        processed_at: admin.firestore.FieldValue.serverTimestamp(),
      });
      await batch.commit();
      return res.status(200).send("ok");
    } catch {
      // User may register later with the same email; keep pending marker.
      const pid = pendingDocId(email);
      const batch = db.batch();
      batch.set(
        db.collection("vip_pending_by_email").doc(pid),
        {
          email,
          payment_id: paymentId,
          created_at: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      batch.set(processedRef, {
        email,
        pending: true,
        processed_at: admin.firestore.FieldValue.serverTimestamp(),
      });
      await batch.commit();
      return res.status(200).send("pending no user");
    }
  } catch (error) {
    console.error("yookassa-webhook:", error);
    return res.status(500).send("error");
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Backend server is running on port ${PORT}`);
});
