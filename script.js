(function () {
  var STORAGE_KEY = "lisan_web_pay_form";

  var DEFAULT_CREATE_PAYMENT_URL =
    "https://lisanalarab-backend-5lbb.onrender.com/create-payment";
  var DEFAULT_VIP_STATUS_URL =
    "https://lisanalarab-backend-5lbb.onrender.com/vip-status";

  var b = document.getElementById("activate-vip");
  var m = document.getElementById("checkout-message");
  var emailEl = document.getElementById("pay-email");
  var passEl = document.getElementById("pay-password");
  var successPanel = document.getElementById("payment-success-panel");
  var successBody = document.getElementById("payment-success-body");
  var successStatus = document.getElementById("payment-success-status");
  var recheckBtn = document.getElementById("recheck-vip-status");
  if (!b) return;

  var pollTimer = null;
  var pollAttempts = 0;
  var MAX_POLL_ATTEMPTS = 45;

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

  function fnUrl() {
    var meta = document.querySelector('meta[name="lisan-create-payment-url"]');
    var fromMeta = meta && meta.getAttribute("content");
    if (fromMeta && String(fromMeta).trim()) return String(fromMeta).trim();
    if (
      typeof window.LISAN_CREATE_PAYMENT_URL === "string" &&
      window.LISAN_CREATE_PAYMENT_URL.trim()
    )
      return window.LISAN_CREATE_PAYMENT_URL.trim();
    return DEFAULT_CREATE_PAYMENT_URL;
  }

  function vipStatusUrl() {
    var meta = document.querySelector('meta[name="lisan-vip-status-url"]');
    var fromMeta = meta && meta.getAttribute("content");
    if (fromMeta && String(fromMeta).trim()) return String(fromMeta).trim();
    return DEFAULT_VIP_STATUS_URL;
  }

  function showSuccessPanel(email) {
    if (!successPanel) return;
    successPanel.hidden = false;
    var card = document.querySelector(".activation-card");
    if (card) card.classList.add("activation-card--paid");
    var formBlock = document.getElementById("checkout-form-block");
    if (formBlock) formBlock.classList.add("checkout-form-block--dimmed");
    try {
      successPanel.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (e) {}
  }

  function setSuccessStatus(text, tone) {
    if (!successStatus) return;
    successStatus.textContent = text || "";
    if (tone) successStatus.dataset.tone = tone;
    else delete successStatus.dataset.tone;
  }

  function successBodyForEmail(email) {
    if (email && isOkEmail(email)) {
      return (
        "Полный доступ (VIP) привязан к почте " +
        email +
        ". Войдите в приложение «Лисан аль‑Араб» с этой же почтой — подписка обновится автоматически."
      );
    }
    return (
      "Войдите в приложение «Лисан аль‑Араб» с той же почтой, что указывали при оплате — полный доступ обновится автоматически."
    );
  }

  function applyVipStatusResult(data, email) {
    var status = data && data.status;
    if (status === "active") {
      setSuccessStatus(
        "VIP активен. Откройте приложение — полный доступ включится автоматически.",
        "success"
      );
      msg("", null);
      stopPolling();
      return true;
    }
    if (status === "pending" || status === "paid_pending_account") {
      setSuccessStatus(
        "Оплата принята. Если в приложении VIP ещё не виден — войдите в аккаунт и нажмите «Проверить подписку» (лучше на Wi‑Fi без VPN).",
        "neutral"
      );
      return false;
    }
    setSuccessStatus(
      "Проверяем статус оплаты… Лучше оставаться на Wi‑Fi без VPN.",
      "neutral"
    );
    return false;
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function fetchVipStatus(email) {
    var url =
      vipStatusUrl() +
      "?email=" +
      encodeURIComponent(normalizeClientEmail(email));
    return fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      credentials: "omit",
      cache: "no-store",
      mode: "cors",
    }).then(function (r) {
      return r.json().catch(function () {
        return { status: "error" };
      });
    });
  }

  function pollVipStatus(email) {
    stopPolling();
    pollAttempts = 0;
    pollTimer = setInterval(function () {
      pollAttempts += 1;
      if (pollAttempts > MAX_POLL_ATTEMPTS) {
        stopPolling();
        setSuccessStatus(
          "Оплата прошла. Если VIP ещё не виден — войдите в приложение и нажмите «Проверить подписку» (Wi‑Fi, без VPN).",
          "neutral"
        );
        return;
      }
      fetchVipStatus(email).then(function (data) {
        applyVipStatusResult(data, email);
      });
    }, 2000);
    fetchVipStatus(email).then(function (data) {
      applyVipStatusResult(data, email);
    });
  }

  function handleReturnFromPayment() {
    try {
      var u = new URL(window.location.href);
      if (u.searchParams.get("vip_return") !== "1") return;
      var em = normalizeClientEmail(emailEl && emailEl.value);
      if (successBody) successBody.textContent = successBodyForEmail(em);
      showSuccessPanel(em);
      setSuccessStatus("Проверяем подписку…", "neutral");
      msg("", null);
      if (em && isOkEmail(em)) pollVipStatus(em);
      else {
        setSuccessStatus(
          "Введите почту из оплаты выше и нажмите «Проверить подписку».",
          "neutral"
        );
      }
      u.searchParams.delete("vip_return");
      var qs = u.searchParams.toString();
      window.history.replaceState({}, "", u.pathname + (qs ? "?" + qs : "") + u.hash);
    } catch (e) {}
  }

  function emailFromPageURL() {
    try {
      var u = new URL(window.location.href);
      var em = normalizeClientEmail(u.searchParams.get("email"));
      return isOkEmail(em) ? em : "";
    } catch (e) {
      return "";
    }
  }

  function restoreFormFromStorage() {
    var fromUrl = emailFromPageURL();
    if (fromUrl && emailEl) {
      emailEl.value = fromUrl;
      return;
    }
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

  if (recheckBtn) {
    recheckBtn.addEventListener("click", function () {
      var email = normalizeClientEmail(emailEl && emailEl.value);
      if (!email || !isOkEmail(email)) {
        setSuccessStatus("Сначала введите почту, которую указывали при оплате.", "error");
        return;
      }
      showSuccessPanel(email);
      if (successBody) successBody.textContent = successBodyForEmail(email);
      setSuccessStatus("Проверяем…", "neutral");
      pollVipStatus(email);
    });
  }

  function postJson(url, bodyStr) {
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: bodyStr,
      credentials: "omit",
      cache: "no-store",
      mode: "cors",
    }).catch(function () {
      return new Promise(function (resolve, reject) {
        var xhr = new XMLHttpRequest();
        xhr.open("POST", url);
        xhr.setRequestHeader("Content-Type", "application/json");
        xhr.onload = function () {
          resolve({
            ok: xhr.status >= 200 && xhr.status < 300,
            status: xhr.status,
            text: function () {
              return Promise.resolve(xhr.responseText || "");
            },
          });
        };
        xhr.onerror = function () {
          reject(new Error("XHR"));
        };
        xhr.send(bodyStr);
      });
    });
  }

  function confirmBeforePay() {
    return true;
  }

  function paymentErrorMessage(d, status) {
    if (d && d.error === "invalid_credentials") {
      return "Неверная почта или пароль. Скопируйте их из вкладки «Аккаунт» в приложении.";
    }
    if (d && d.error === "invalid_body") {
      return "Укажите почту и пароль — те же, что в приложении.";
    }
    return (
      (d && d.description) ||
      (d && d.details && d.details.description) ||
      (d && d.error) ||
      "Ошибка " + status
    );
  }

  b.addEventListener("click", function () {
    if (location.protocol === "file:") {
      msg("Откройте сайт по HTTPS на Render (деплой статики), не файл с диска.", "error");
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

    var password = passEl ? String(passEl.value || "") : "";
    if (!password) {
      msg("Введите пароль из приложения (вкладка «Аккаунт»).", "error");
      return;
    }

    if (!confirmBeforePay()) {
      msg("Оплата отменена. Подключитесь к Wi‑Fi без VPN и попробуйте снова.", "neutral");
      return;
    }

    b.disabled = true;
    msg("Создаём платёж для " + email + "…", "neutral");

    var url = fnUrl();
    var payload = JSON.stringify({ email: email, password: password });
    postJson(url, payload)
      .then(function (r) {
        return r.text().then(function (t) {
          var d = {};
          try {
            d = t ? JSON.parse(t) : {};
          } catch (e) {
            msg(
              "Сервер не вернул JSON. Проверьте адрес API и что сервис на Render запущен.",
              "error"
            );
            b.disabled = false;
            return;
          }
          if (!r.ok) {
            msg(paymentErrorMessage(d, r.status), "error");
            b.disabled = false;
            return;
          }
          if (d.customer_email && normalizeClientEmail(d.customer_email) !== email) {
            msg("Внутренняя ошибка: почта в ответе не совпадает. Обновите страницу.", "error");
            b.disabled = false;
            return;
          }
          var pay =
            (d.confirmation && d.confirmation.confirmation_url) || d.confirmation_url;
          if (pay) {
            saveFormToStorage();
            window.location.href = pay;
            return;
          }
          msg(
            "Нет ссылки на оплату. Попробуйте позже или напишите в поддержку.",
            "error"
          );
          b.disabled = false;
        });
      })
      .catch(function () {
        msg(
          "Не удалось отправить запрос. Подключитесь к Wi‑Fi, отключите VPN и попробуйте снова.",
          "error"
        );
        b.disabled = false;
      });
  });
})();
