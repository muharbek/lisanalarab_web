(function () {
  var STORAGE_KEY = "lisan_web_pay_form";

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

  function fnUrl() {
    try {
      return new URL("/.netlify/functions/create-payment", window.location.origin).href;
    } catch (e) {
      return "/.netlify/functions/create-payment";
    }
  }

  function postJson(url, bodyStr) {
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: bodyStr,
      credentials: "same-origin",
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

  b.addEventListener("click", function () {
    if (location.protocol === "file:") {
      msg("Откройте сайт по HTTPS на Netlify (не файл с диска).", "error");
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

    b.disabled = true;
    msg("Создаём платёж для " + email + "…", "neutral");

    var url = fnUrl();
    var payload = JSON.stringify({ email: email });
    postJson(url, payload)
      .then(function (r) {
        return r.text().then(function (t) {
          var d = {};
          try {
            d = t ? JSON.parse(t) : {};
          } catch (e) {
            msg(
              "Сервер не вернул JSON. Проверьте деплой функции create-payment и настройки Netlify.",
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
          var pay =
            (d.confirmation && d.confirmation.confirmation_url) || d.confirmation_url;
          if (pay) {
            saveFormToStorage();
            window.location.href = pay;
            return;
          }
          msg("Нет ссылки на оплату в ответе.", "error");
          b.disabled = false;
        });
      })
      .catch(function (e) {
        msg(
          "Не удалось отправить запрос. Проверьте HTTPS, функции Netlify и интернет.",
          "error"
        );
        b.disabled = false;
      });
  });
})();
