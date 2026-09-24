// Личные пароли сотрудников на экране входа: вход по логину и паролю
// и «Первый вход» по коду приглашения.
const MIN_PASSWORD = 10;

export const personalLoginHtml = () =>
  `<form id="personal-login" class="access-form"><label for="personal-login-name">Логин</label><input id="personal-login-name" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="100" required><label for="personal-login-password">Пароль</label><input id="personal-login-password" type="password" autocomplete="current-password" maxlength="256" required><label class="check"><input id="personal-login-remember" type="checkbox"> Запомнить на этом устройстве (30 дней, только для преподавателей)</label><small class="muted">Не отмечайте на общих компьютерах.</small><p id="personal-login-error" class="notice warn" role="alert" hidden></p><button class="btn primary">Войти →</button><button type="button" class="button-link" id="forgot-open" aria-expanded="false" aria-controls="forgot-text">Забыли пароль?</button><p id="forgot-text" class="muted" hidden>Сбросить пароль может менеджер вашей программы или администратор журнала. Они выдадут новый код для первого входа.</p></form>`;

export function wirePersonalLogin({ api, onLogin }) {
  const $ = (s) => document.querySelector(s);
  const form = $("#personal-login");
  if (!form) return;
  $("#forgot-open").onclick = () => {
    const text = $("#forgot-text");
    text.hidden = !text.hidden;
    $("#forgot-open").setAttribute("aria-expanded", String(!text.hidden));
  };
  const error = $("#personal-login-error");
  form.onsubmit = async (e) => {
    e.preventDefault();
    error.hidden = true;
    const button = form.querySelector("button.btn");
    button.disabled = true;
    try {
      const r = await api("/api/login", {
        method: "POST",
        body: JSON.stringify({
          login: $("#personal-login-name").value.trim(),
          password: $("#personal-login-password").value,
          remember: $("#personal-login-remember").checked,
        }),
      });
      await onLogin(r.user);
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
    } finally {
      button.disabled = false;
    }
  };
}

export const firstLoginHtml = () =>
  `<div class="login-links"><button type="button" class="button-link" id="first-login-open" aria-expanded="false" aria-controls="first-login">Первый вход по коду приглашения</button></div><form id="first-login" class="access-form" hidden><h2>Первый вход</h2><p class="muted">Введите логин и код из приглашения и придумайте пароль не короче ${MIN_PASSWORD} символов.</p><label for="first-login-name">Логин</label><input id="first-login-name" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="100" required><label for="first-login-code">Код приглашения</label><input id="first-login-code" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" maxlength="40" required><label for="first-login-password">Новый пароль</label><input id="first-login-password" type="password" autocomplete="new-password" minlength="${MIN_PASSWORD}" maxlength="256" required><label for="first-login-repeat">Повторите пароль</label><input id="first-login-repeat" type="password" autocomplete="new-password" maxlength="256" required><p id="first-login-error" class="notice warn" role="alert" hidden></p><button class="btn primary">Задать пароль и войти →</button></form>`;

// onLogin(user) вызывается после успешного входа; ошибки показываются в форме.
export function wireFirstLogin({ api, onLogin }) {
  const $ = (s) => document.querySelector(s);
  const form = $("#first-login"),
    opener = $("#first-login-open");
  if (!form || !opener) return;
  opener.onclick = () => {
    form.hidden = !form.hidden;
    opener.setAttribute("aria-expanded", String(!form.hidden));
    if (!form.hidden) $("#first-login-name").focus();
  };
  const showError = (message) => {
    const el = $("#first-login-error");
    el.textContent = message;
    el.hidden = !message;
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const password = $("#first-login-password").value;
    if (password !== $("#first-login-repeat").value)
      return showError("Пароли не совпадают");
    if (password.length < MIN_PASSWORD)
      return showError(`Пароль должен быть не короче ${MIN_PASSWORD} символов`);
    showError("");
    const button = form.querySelector("button");
    button.disabled = true;
    try {
      const r = await api("/api/first-login", {
        method: "POST",
        body: JSON.stringify({
          login: $("#first-login-name").value.trim(),
          code: $("#first-login-code").value.trim(),
          password,
        }),
      });
      await onLogin(r.user);
    } catch (err) {
      showError(err.message);
    } finally {
      button.disabled = false;
    }
  };
}
