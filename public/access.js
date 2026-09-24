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

const shortDate = (ms) =>
  new Date(ms).toLocaleDateString("ru-RU", { day: "numeric", month: "long" });

// Строка состояния доступа для страницы «Сотрудники».
export function accessLabel(access) {
  if (access.state === "active")
    return (
      "Активен" +
      (access.lastLoginAt
        ? ", вход " +
          new Date(access.lastLoginAt).toLocaleDateString("ru-RU", {
            day: "numeric",
            month: "short",
          })
        : "")
    );
  if (access.state === "invited")
    return "Приглашён до " + shortDate(access.expires);
  return "Нет доступа";
}

export const inviteLetter = ({ name, login, code, expires }, origin) =>
  `Здравствуйте, ${name}!\n\nВам открыт доступ к журналу посещаемости иностранных студентов факультета права.\nАдрес: ${origin}\nЛогин: ${login}\nКод для первого входа: ${code} (действует до ${shortDate(expires)})\n\nНа экране входа выберите «Первый вход по коду приглашения» и придумайте пароль не короче ${MIN_PASSWORD} символов.`;

// Окно с логином и кодом: код показывается один раз и после закрытия не восстанавливается.
export function showInvite(invite, { esc, origin = location.origin }) {
  const dialog = document.createElement("dialog");
  dialog.className = "invite-dialog";
  dialog.setAttribute("aria-labelledby", "invite-title");
  const letter = inviteLetter(invite, origin);
  dialog.innerHTML = `<h2 id="invite-title">${invite.reset ? "Пароль сброшен" : "Доступ выдан"}</h2><p>${esc(invite.name)}</p><dl class="invite-code"><dt>Логин</dt><dd id="invite-login">${esc(invite.login)}</dd><dt>Код приглашения</dt><dd id="invite-code">${esc(invite.code)}</dd><dt>Действует до</dt><dd>${esc(shortDate(invite.expires))}</dd></dl><p class="notice warn">Код показывается один раз. После закрытия окна получить его снова нельзя – только выдать новый.</p><label for="invite-letter">Текст письма</label><textarea id="invite-letter" rows="8" readonly>${esc(letter)}</textarea><div class="dialog-actions"><button type="button" class="btn" id="invite-copy">Скопировать письмо</button><button type="button" class="btn primary" id="invite-close">Закрыть</button></div>`;
  document.body.append(dialog);
  const close = () => {
    dialog.close?.();
    dialog.remove();
  };
  dialog.querySelector("#invite-close").onclick = close;
  dialog.addEventListener("cancel", close);
  dialog.querySelector("#invite-copy").onclick = async () => {
    const button = dialog.querySelector("#invite-copy");
    try {
      await navigator.clipboard.writeText(letter);
      button.textContent = "Скопировано";
    } catch {
      // Без доступа к буферу – выделить текст, чтобы скопировать вручную.
      dialog.querySelector("#invite-letter").select();
      button.textContent = "Выделено – нажмите Ctrl+C";
    }
  };
  if (dialog.showModal) dialog.showModal();
  else dialog.setAttribute("open", "");
  return dialog;
}

// Массовая выгрузка кодов: CSV приходит в ответ на POST, поэтому скачивается через blob.
export async function exportInvites({ ask }) {
  const confirmed = await ask({
    title: "Выгрузить коды приглашения?",
    text: "Каждому сотруднику без пароля будет выдан новый код, прежние неиспользованные коды перестанут действовать. Файл содержит действующие коды: удалите его сразу после рассылки.",
    ok: "Выгрузить",
  });
  if (!confirmed) return false;
  const r = await fetch("/api/admin/access-export", {
    method: "POST",
    signal: AbortSignal.timeout(60000),
  });
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    throw Error(data.error || "Не удалось выгрузить коды");
  }
  const url = URL.createObjectURL(await r.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = "invite-codes.csv";
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}
