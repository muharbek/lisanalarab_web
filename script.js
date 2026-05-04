(function () {
  var STORAGE_KEY = "lisan_web_pay_form";
  var DEFAULT_CREATE_PAYMENT_URL =
    "https://lisanalarab-backend-5lbb.onrender.com/create-payment";

  var b = document.getElementById("activate-vip");
  var m = document.getElementById("checkout-message");
  var emailEl = document.getElementById("pay-email");
  var passEl = document.getElementById("pay-password");
  if (!b) return;

  /** Как на сервере: trim + toLowerCase — совпадает с Firebase Auth. */
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
            ". Открываем приложение… Если не открылось — запустите «Лисан аль‑Араб» вручную; доступ подтянется с сервера."
          : "Оплата прошла успешно. Открываем приложение… Если не открылось — войдите в «Лисан аль‑Араб» с той же почтой — VIP обновится автоматически.";
      msg(line, "success");
      if (u.searchParams.get("open_app") === "1") {
        window.location.href = "lisanalarab://vip-paid";
      }
      u.searchParams.delete("vip_return");
      u.searchParams.delete("open_app");
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

  function fnUrl() {
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

    b.disabled = true;
    msg("Создаём платёж для " + email + "…", "neutral");

    var url = fnUrl();
    var payload = JSON.stringify({ email: email, password: password });
    postJson(url, payload)
      .then(function (r) {
        return r.text().then(function (t) {
          var raw = (t || "").trim();
          var d = {};

          if (r.status === 404 || /^not\s*found$/i.test(raw)) {
            msg(
              "Платёжный сервер не найден по этому адресу (404): Web Service на Render не запущен, удалён или URL в мета-теге не совпадает с сервисом. Откройте Render → ваш сервис → скопируйте точный URL и обновите lisan-create-payment-url.",
              "error"
            );
            b.disabled = false;
            return;
          }

          try {
            d = raw ? JSON.parse(raw) : {};
          } catch (e) {
            msg(
              "Ответ сервера не JSON — проверьте деплой API и путь /create-payment.",
              "error"
            );
            b.disabled = false;
            return;
          }
          if (!r.ok) {
            msg(
              d.description ||
                (d.details && d.details.description) ||
                d.error ||
                "Ошибка " + r.status,
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
          // Backend returns confirmation_url from YooKassa; redirect user to the hosted payment page.
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
        });
      })
      .catch(function () {
        msg(
          "Запрос к «" +
            url +
            "» не выполнился (нет ответа, CORS или сервис спит). " +
            "На Render должен быть именно Web Service с командой npm start из корня этого репозитория; в Environment нужны YOOKASSA_SECRET_KEY и FIREBASE_WEB_API_KEY (PUBLIC_ORIGIN по умолчанию уже задан в коде бэкенда). " +
            "Откройте в браузере базовый URL сервиса (без /create-payment) — если не открывается JSON с ok:true, мета-тег lisan-create-payment-url указывает не на тот сервис. " +
            "На бесплатном тарифе первый запрос после простоя может занять 1–2 минуты — подождите и нажмите снова.",
          "error"
        );
        b.disabled = false;
      });
  });
})();
