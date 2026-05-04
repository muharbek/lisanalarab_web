(function () {
  var STORAGE_KEY = "lisan_web_pay_form";
  var DEFAULT_CREATE_PAYMENT_URL =
    "https://lisanalarab-backend-5lbb.onrender.com/create-payment";

  var INVALID_APP_LOGIN =
    "Invalid email or password from your app account.";

  var b = document.getElementById("activate-vip");
  var m = document.getElementById("checkout-message");
  var emailEl = document.getElementById("pay-email");
  var passEl = document.getElementById("pay-password");
  if (!b) return;

  /** Match Firebase Auth: trim + lower case. */
  function normalizeClientEmail(raw) {
    if (raw == null || raw === "") return "";
    return String(raw).trim().toLowerCase();
  }

  function isOkEmail(email) {
    if (!email || email.length > 254) return false;
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  function msg(t, tone) {
    if (!m) return;
    m.textContent = t || "";
    if (tone) m.dataset.tone = tone;
    else delete m.dataset.tone;
  }

  function handleReturnFromPayment() {
    try {
      var u = new URL(window.location.href);
      if (u.searchParams.get("vip_return") !== "1") return;
      var em = normalizeClientEmail(emailEl && emailEl.value);
      var line =
        em && isOkEmail(em)
          ? "Оплата прошла успешно. Полный доступ (VIP) привязан к почте " +
            em +
            ". Войдите в приложение «Лисан аль‑Араб» с этой же почтой — доступ обновится автоматически."
          : "Оплата прошла успешно. Войдите в приложение «Лисан аль‑Араб» с той же почтой, что указывали при оплате — полный доступ (VIP) обновится автоматически.";
      msg(line, "success");
      u.searchParams.delete("vip_return");
      var qs = u.searchParams.toString();
      window.history.replaceState({}, "", u.pathname + (qs ? "?" + qs : "") + u.hash);
    } catch (e) {}
  }

  function restoreFormFromStorage() {
    try {
      var raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      var o = JSON.parse(raw);
      if (emailEl && typeof o.email === "string") emailEl.value = o.email;
      if (passEl && typeof o.password === "string") passEl.value = o.password;
    } catch (e) {}
  }

  function saveFormToStorage() {
    try {
      sessionStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          email: normalizeClientEmail(emailEl && emailEl.value),
          password: (passEl && passEl.value) || "",
        })
      );
    } catch (e) {}
  }

  restoreFormFromStorage();
  handleReturnFromPayment();

  function fnCreatePaymentUrl() {
    try {
      var el = document.querySelector('meta[name="lisan-create-payment-url"]');
      var c = el && el.getAttribute("content");
      if (c) {
        var s = String(c).trim();
        if (s) return s;
      }
    } catch (e) {}
    return DEFAULT_CREATE_PAYMENT_URL;
  }

  /** Same Render service: /verify-app-login and /create-payment share origin. */
  function apiOrigin() {
    try {
      return new URL(fnCreatePaymentUrl()).origin;
    } catch (e) {
      try {
        return new URL(DEFAULT_CREATE_PAYMENT_URL).origin;
      } catch (e2) {
        return "";
      }
    }
  }

  function verifyAppLoginUrl() {
    return apiOrigin() + "/verify-app-login";
  }

  function postJson(url, bodyStr) {
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: bodyStr,
      credentials: "omit",
      cache: "no-store",
      mode: "cors",
    });
  }

  function parseJsonBody(t) {
    var raw = (t || "").trim();
    if (raw === "" || /^not\s*found$/i.test(raw)) {
      return { parseError: true, notFound: /^not\s*found$/i.test(raw), raw: raw };
    }
    try {
      return { data: raw ? JSON.parse(raw) : {} };
    } catch (e) {
      return { parseError: true, raw: raw };
    }
  }

  b.addEventListener("click", function () {
    if (location.protocol === "file:") {
      msg("Откройте сайт по HTTPS (не файл с диска).", "error");
      return;
    }
    if (!location.origin || location.origin === "null") {
      msg("Некорректный адрес страницы.", "error");
      return;
    }

    var email = normalizeClientEmail(emailEl && emailEl.value);
    if (!email) {
      msg("Введите электронную почту — ту же, что в приложении.", "error");
      return;
    }
    if (!isOkEmail(email)) {
      msg("Проверьте формат электронной почты.", "error");
      return;
    }

    var password = (passEl && passEl.value) || "";
    if (!password) {
      msg("Введите пароль из приложения.", "error");
      return;
    }

    var createUrl = fnCreatePaymentUrl();
    var verifyUrl = verifyAppLoginUrl();
    if (!verifyUrl || verifyUrl.indexOf("/verify-app-login") === -1) {
      msg("Некорректный адрес API. Проверьте мета-тег lisan-create-payment-url.", "error");
      return;
    }

    var authPayload = JSON.stringify({ email: email, password: password });

    b.disabled = true;
    msg("Проверяем учётную запись приложения…", "neutral");

    postJson(verifyUrl, authPayload)
      .then(function (r) {
        return r.text().then(function (t) {
          return { r: r, t: t };
        });
      })
      .then(function (_ref) {
        var r = _ref.r;
        var t = _ref.t;
        if (r.status === 404 || /^not\s*found$/i.test((t || "").trim())) {
          msg(
            "Сервер проверки входа не найден (404). Проверьте URL бэкенда на Render и мета-тег lisan-create-payment-url.",
            "error"
          );
          b.disabled = false;
          return;
        }
        var parsed = parseJsonBody(t);
        if (parsed.parseError) {
          msg("Ответ сервера при проверке входа не JSON.", "error");
          b.disabled = false;
          return;
        }
        var d = parsed.data;
        if (!r.ok) {
          msg(
            (d && d.message) ||
              (d && d.description) ||
              (r.status === 401 ? INVALID_APP_LOGIN : "Ошибка проверки входа: " + r.status),
            "error"
          );
          b.disabled = false;
          return;
        }
        if (!d || !d.ok) {
          msg(INVALID_APP_LOGIN, "error");
          b.disabled = false;
          return;
        }

        msg("Создаём платёж для " + email + "…", "neutral");
        return postJson(createUrl, authPayload).then(function (r2) {
          return r2.text().then(function (t2) {
            return { r: r2, t: t2 };
          });
        });
      })
      .then(function (second) {
        if (!second) return;
        var r = second.r;
        var t = second.t;
        if (r.status === 404 || /^not\s*found$/i.test((t || "").trim())) {
          msg(
            "Платёжный сервер не найден (404). Обновите мета-тег lisan-create-payment-url.",
            "error"
          );
          b.disabled = false;
          return;
        }
        var parsed = parseJsonBody(t);
        if (parsed.parseError) {
          msg("Ответ сервера при создании платежа не JSON.", "error");
          b.disabled = false;
          return;
        }
        var d = parsed.data;
        if (!r.ok) {
          msg(
            (d && d.description) ||
              (d && d.message) ||
              (r.status === 401 ? INVALID_APP_LOGIN : d.error || "Ошибка " + r.status),
            "error"
          );
          b.disabled = false;
          return;
        }
        if (d.customer_email && normalizeClientEmail(d.customer_email) !== email) {
          msg("Внутренняя ошибка: почта в ответе не совпадает. Обновите страницу и попробуйте снова.", "error");
          b.disabled = false;
          return;
        }
        var confirmationUrl =
          d.confirmation_url ||
          (d.confirmation && d.confirmation.confirmation_url);
        if (confirmationUrl) {
          saveFormToStorage();
          window.location.href = confirmationUrl;
          return;
        }
        msg("Нет ссылки на оплату в ответе.", "error");
        b.disabled = false;
      })
      .catch(function () {
        msg(
          "Запрос к API не выполнился (сеть или CORS). Проверьте: «" +
            verifyAppLoginUrl() +
            "» и «" +
            fnCreatePaymentUrl() +
            "».",
          "error"
        );
        b.disabled = false;
      });
  });
})();
