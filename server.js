const express = require("express");
const cors = require("cors");
const https = require("https");
const crypto = require("crypto");
const ipRangeCheck = require("ip-range-check");
const admin = require("firebase-admin");
require("dotenv").config();

// Main checkout site after YooKassa payment (used if PUBLIC_ORIGIN is not set on Render).
const DEFAULT_PUBLIC_ORIGIN = "https://lisanalarab-web.onrender.com";

const INVALID_APP_LOGIN_MESSAGE =
  "Invalid email or password from your app account.";

const SHOP_ID = String(process.env.YOOKASSA_SHOP_ID || "1347048").trim();
const SECRET_KEY =
  process.env.YOOKASSA_SECRET_KEY &&
  String(process.env.YOOKASSA_SECRET_KEY).trim();

const FIREBASE_WEB_API_KEY =
  process.env.FIREBASE_WEB_API_KEY &&
  String(process.env.FIREBASE_WEB_API_KEY).trim();

const USERS_COLLECTION =
  String(process.env.FIRESTORE_USERS_COLLECTION || "users").trim() || "users";

const YOOKASSA_WEBHOOK_CIDRS = [
  "185.71.76.0/27",
  "185.71.77.0/27",
  "77.75.153.0/25",
  "77.75.154.128/25",
  "77.75.156.11/32",
  "77.75.156.35/32",
  "2a02:5180::/32",
];

const app = express();

app.use(
  cors({
    origin: "*",
    methods: ["GET", "HEAD", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Accept"],
    maxAge: 86400,
  })
);

app.options("/create-payment", (_req, res) => res.sendStatus(204));
app.options("/verify-app-login", (_req, res) => res.sendStatus(204));
app.options("/yookassa-webhook", (_req, res) => res.sendStatus(204));

app.use(express.json({ limit: "512kb" }));

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function normalizeEmail(raw) {
  if (raw == null || raw === "") return "";
  return String(raw).trim().toLowerCase();
}

function isValidEmail(email) {
  if (!email || email.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/** YooKassa metadata: non-empty string, max 256 chars. */
function yookassaMetadataValue(s) {
  const t = String(s == null ? "" : s).trim();
  if (!t) return "";
  return t.length > 256 ? t.slice(0, 256) : t;
}

function httpsJsonRequest(hostname, pathWithQuery, method, headers, bodyStr) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname,
        path: pathWithQuery,
        method,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(bodyStr || "", "utf8"),
          ...headers,
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
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function yooKassaPostPayment(idempotenceKey, authorization, bodyStr) {
  return httpsJsonRequest(
    "api.yookassa.ru",
    "/v3/payments",
    "POST",
    {
      Authorization: authorization,
      "Idempotence-Key": idempotenceKey,
    },
    bodyStr
  );
}

function yooKassaGetPayment(paymentId, authorization) {
  return httpsJsonRequest(
    "api.yookassa.ru",
    `/v3/payments/${encodeURIComponent(paymentId)}`,
    "GET",
    { Authorization: authorization },
    ""
  );
}

function ykAuthHeader() {
  return (
    "Basic " +
    Buffer.from(`${SHOP_ID}:${SECRET_KEY}`, "utf8").toString("base64")
  );
}

// ---------------------------------------------------------------------------
// Firebase Admin — only process.env.FIREBASE_SERVICE_ACCOUNT (never a file path or hardcoded keys).
// ---------------------------------------------------------------------------

function ensureFirebaseAdmin() {
  if (admin.apps.length) return;
  if (
    !process.env.FIREBASE_SERVICE_ACCOUNT ||
    !String(process.env.FIREBASE_SERVICE_ACCOUNT).trim()
  ) {
    const e = new Error("FIREBASE_SERVICE_ACCOUNT is not set");
    e.statusCode = 503;
    throw e;
  }
  let serviceAccount;
  try {
    serviceAccount = JSON.parse(
      String(process.env.FIREBASE_SERVICE_ACCOUNT).trim()
    );
  } catch {
    try {
      serviceAccount = JSON.parse(
        Buffer.from(
          String(process.env.FIREBASE_SERVICE_ACCOUNT).trim(),
          "base64"
        ).toString("utf8")
      );
    } catch {
      const err = new Error(
        "FIREBASE_SERVICE_ACCOUNT must be valid one-line JSON or base64-encoded JSON"
      );
      err.statusCode = 503;
      throw err;
    }
  }
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

// ---------------------------------------------------------------------------
// Firebase Auth — verify email/password via Identity Toolkit REST (Admin SDK cannot check passwords).
// ---------------------------------------------------------------------------

async function verifyAppCredentials(emailNorm, password) {
  if (!FIREBASE_WEB_API_KEY) {
    const e = new Error("FIREBASE_WEB_API_KEY is not set");
    e.statusCode = 503;
    throw e;
  }
  const path =
    "/v1/accounts:signInWithPassword?key=" +
    encodeURIComponent(FIREBASE_WEB_API_KEY);
  const bodyStr = JSON.stringify({
    returnSecureToken: true,
    email: emailNorm,
    password: String(password || ""),
  });
  const { statusCode, raw } = await httpsJsonRequest(
    "identitytoolkit.googleapis.com",
    path,
    "POST",
    {},
    bodyStr
  );
  let parsed = {};
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    parsed = {};
  }
  if (statusCode >= 200 && statusCode < 300 && parsed.localId) {
    return { ok: true, localId: parsed.localId, email: parsed.email || emailNorm };
  }
  const errMsg =
    parsed.error && parsed.error.message ? String(parsed.error.message) : "";
  const authFailed =
    statusCode === 400 &&
    /INVALID_PASSWORD|EMAIL_NOT_FOUND|INVALID_EMAIL|MISSING_PASSWORD|INVALID_LOGIN_CREDENTIALS|USER_DISABLED/i.test(
      errMsg
    );
  if (authFailed || statusCode === 401) {
    const e = new Error(INVALID_APP_LOGIN_MESSAGE);
    e.statusCode = 401;
    e.expose = true;
    throw e;
  }
  const e = new Error(
    parsed.error && parsed.error.message
      ? parsed.error.message
      : "identity_toolkit_error"
  );
  e.statusCode = statusCode >= 400 && statusCode < 600 ? statusCode : 502;
  throw e;
}

// ---------------------------------------------------------------------------
// Firestore — grant VIP after verified YooKassa payment
// ---------------------------------------------------------------------------

function clientIpFromReq(req) {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length) return xff.split(",")[0].trim();
  const src =
    req.headers["client-ip"] ||
    req.socket?.remoteAddress ||
    req.ip ||
    "";
  return String(src).replace(/^::ffff:/, "");
}

function assertYooKassaWebhookIp(req) {
  if (process.env.SKIP_YOOKASSA_WEBHOOK_IP_CHECK === "1") return;
  const ip = clientIpFromReq(req);
  const ok = YOOKASSA_WEBHOOK_CIDRS.some((cidr) => {
    try {
      return ipRangeCheck(ip, cidr);
    } catch {
      return false;
    }
  });
  if (!ok) {
    const e = new Error(`webhook ip rejected: ${ip}`);
    e.statusCode = 403;
    throw e;
  }
}

function emailFromPaymentMetadata(live) {
  const meta =
    live.metadata && typeof live.metadata === "object" ? live.metadata : {};
  const raw =
    (typeof meta.customer_email === "string" && meta.customer_email) ||
    (typeof meta.user_email === "string" && meta.user_email) ||
    "";
  const normalized = normalizeEmail(raw);
  const clipped = yookassaMetadataValue(normalized);
  if (!clipped || !isValidEmail(clipped)) return "";
  return clipped;
}

async function grantVipForEmail(emailNorm, paymentId) {
  ensureFirebaseAdmin();
  const db = admin.firestore();
  const processedRef = db.collection("yookassa_processed_payments").doc(paymentId);
  const already = await processedRef.get();
  if (already.exists) {
    return { duplicate: true };
  }

  const batch = db.batch();
  let updated = false;

  try {
    const userRecord = await admin.auth().getUserByEmail(emailNorm);
    batch.set(
      db.collection(USERS_COLLECTION).doc(userRecord.uid),
      {
        isVip: true,
        vip_updated_at: admin.firestore.FieldValue.serverTimestamp(),
        vip_payment_id: paymentId,
      },
      { merge: true }
    );
    updated = true;
  } catch {
    const snap = await db
      .collection(USERS_COLLECTION)
      .where("email", "==", emailNorm)
      .limit(10)
      .get();
    if (!snap.empty) {
      snap.forEach((doc) => {
        batch.set(
          doc.ref,
          {
            isVip: true,
            vip_updated_at: admin.firestore.FieldValue.serverTimestamp(),
            vip_payment_id: paymentId,
          },
          { merge: true }
        );
        updated = true;
      });
    }
  }

  if (!updated) {
    const pendingId = Buffer.from(emailNorm, "utf8")
      .toString("base64")
      .replace(/\//g, "_")
      .replace(/\+/g, "-");
    batch.set(
      db.collection("vip_pending_by_email").doc(pendingId),
      {
        email: emailNorm,
        payment_id: paymentId,
        created_at: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  }

  batch.set(processedRef, {
    email: emailNorm,
    processed_at: admin.firestore.FieldValue.serverTimestamp(),
    pending_grant: !updated,
  });

  await batch.commit();
  return { duplicate: false, updated, email: emailNorm };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "lisanalarab-backend",
    verifyLogin: "POST /verify-app-login",
    createPayment: "POST /create-payment",
    yookassaWebhook: "POST /yookassa-webhook",
  });
});

app.post("/verify-app-login", async (req, res) => {
  try {
    const email = normalizeEmail(req.body && req.body.email);
    const password = (req.body && req.body.password) || "";
    if (!email || !isValidEmail(email)) {
      return res.status(400).json({
        error: "invalid_email",
        message: "Provide a valid email address.",
      });
    }
    if (!password) {
      return res.status(400).json({
        error: "missing_password",
        message: "Password is required.",
      });
    }
    await verifyAppCredentials(email, password);
    return res.json({ ok: true });
  } catch (err) {
    if (err.statusCode === 401 && err.expose) {
      return res.status(401).json({
        error: "invalid_credentials",
        message: INVALID_APP_LOGIN_MESSAGE,
      });
    }
    console.error("verify-app-login:", err);
    return res.status(err.statusCode || 500).json({
      error: "verify_failed",
      message: err.message || "Verification failed.",
    });
  }
});

app.post("/create-payment", async (req, res) => {
  try {
    const email = normalizeEmail(req.body && req.body.email);
    const password = (req.body && req.body.password) || "";
    if (!email || !isValidEmail(email)) {
      return res.status(400).json({
        error: "invalid_email",
        description: "Provide a valid email address.",
      });
    }
    if (!password) {
      return res.status(400).json({
        error: "missing_password",
        description: "Password is required.",
      });
    }

    try {
      await verifyAppCredentials(email, password);
    } catch (err) {
      if (err.statusCode === 401 && err.expose) {
        return res.status(401).json({
          error: "invalid_credentials",
          description: INVALID_APP_LOGIN_MESSAGE,
        });
      }
      throw err;
    }

    if (!SECRET_KEY) {
      return res.status(500).json({
        error: "missing_env",
        description: "Set YOOKASSA_SECRET_KEY on Render.",
      });
    }

    const publicOrigin = String(
      (process.env.PUBLIC_ORIGIN && process.env.PUBLIC_ORIGIN.trim()) ||
        DEFAULT_PUBLIC_ORIGIN
    ).replace(/\/$/, "");

    const returnUrl = `${publicOrigin}/?vip_return=1`;
    const metaEmail = yookassaMetadataValue(email);

    const paymentPayload = {
      amount: { value: "150.00", currency: "RUB" },
      capture: true,
      confirmation: {
        type: "redirect",
        return_url: returnUrl,
      },
      description: "Lisan Al-Arab VIP subscription",
      metadata: {
        source: "web_checkout",
        customer_email: metaEmail,
      },
    };

    const bodyStr = JSON.stringify(paymentPayload);
    const auth = ykAuthHeader();

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
      console.log("Payment created:", parsed.id, email);
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
    return res.status(statusCode >= 400 && statusCode < 600 ? statusCode : 502).json({
      error: parsed.type || "payment_failed",
      description: message,
      details: parsed,
    });
  } catch (error) {
    console.error("create-payment:", error);
    return res.status(error.statusCode || 500).json({
      error: "server_error",
      description: error.message || String(error),
    });
  }
});

app.post("/yookassa-webhook", async (req, res) => {
  try {
    assertYooKassaWebhookIp(req);
  } catch (e) {
    return res.status(e.statusCode || 403).send("forbidden");
  }

  if (!SECRET_KEY) {
    return res.status(503).send("no secret");
  }

  const body =
    req.body && typeof req.body === "object" ? req.body : null;
  if (!body) {
    return res.status(400).send("bad json");
  }

  if (body.type !== "notification") {
    return res.status(400).send("bad type");
  }

  if (body.event !== "payment.succeeded") {
    return res.status(200).send("ok");
  }

  const paymentId = body.object && body.object.id;
  if (!paymentId) {
    return res.status(400).send("no id");
  }

  let live;
  try {
    const { statusCode, raw } = await yooKassaGetPayment(
      paymentId,
      ykAuthHeader()
    );
    live = raw ? JSON.parse(raw) : {};
    if (statusCode < 200 || statusCode >= 300) {
      return res.status(502).send("yk get failed");
    }
  } catch {
    return res.status(502).send("yk get error");
  }

  if (live.status !== "succeeded" || live.paid !== true) {
    return res.status(400).send("not paid");
  }

  const emailNorm = emailFromPaymentMetadata(live);
  if (!emailNorm) {
    return res.status(200).send("no email in metadata");
  }

  try {
    await grantVipForEmail(emailNorm, paymentId);
  } catch (e) {
    console.error("webhook firestore:", e);
    return res.status(503).send("firebase error");
  }

  return res.status(200).send("ok");
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Backend server is running on port ${PORT}`);
});
