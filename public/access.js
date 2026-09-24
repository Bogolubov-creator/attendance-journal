// Личные пароли сотрудников на экране входа: вход по логину и паролю
// и «Первый вход» по коду приглашения.
const MIN_PASSWORD = 10;
// Проверки, которые форма делает до запроса; остальное проверяет сервер.
const localProblem = (password, repeat) =>
  password !== repeat
    ? "Пароли не совпадают"
    : password.length < MIN_PASSWORD
      ? `Пароль должен быть не короче ${MIN_PASSWORD} символов`
      : "";
const errorShower = (el) => (message) => {
  el.textContent = message;
  el.hidden = !message;
};

export const personalLoginHtml = () =>
  `<form id="personal-login" class="access-form"><label for="personal-login-name">Логин</label><input id="personal-login-name" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="100" required><label for="personal-login-password">Пароль</label><input id="personal-login-password" type="password" autocomplete="current-password" maxlength="256" required><label class="check"><input id="personal-login-remember" type="checkbox"> Запомнить на этом устройстве (30 дней, только для преподавателей)</label><small class="muted">Не отмечайте на общих компьютерах.</small><p id="personal-login-error" class="notice warn" role="alert" hidden></p><button class="btn primary">Войти →</button><button type="button" class="button-link" id="forgot-open" aria-expanded="false" aria-controls="forgot-text">Забыли пароль?</button><p id="forgot-text" class="muted" hidden>Обратитесь к менеджеру своей программы или к администратору журнала: пароль сбросит администратор и выдаст новый код для первого входа.</p></form>`;

export function wirePersonalLogin({ api, onLogin }) {
  const $ = (s) => document.querySelector(s);
  const form = $("#personal-login");
  if (!form) return;
  $("#forgot-open").onclick = () => {
    const text = $("#forgot-text");
    text.hidden = !text.hidden;
    $("#forgot-open").setAttribute("aria-expanded", String(!text.hidden));
  };
  const showError = errorShower($("#personal-login-error"));
  form.onsubmit = async (e) => {
    e.preventDefault();
    showError("");
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
      showError(err.message);
    } finally {
      button.disabled = false;
    }
  };
}

export const firstLoginHtml = () =>
  `<div class="login-links"><button type="button" class="button-link" id="first-login-open" aria-expanded="false" aria-controls="first-login">Первый вход по коду приглашения</button></div><form id="first-login" class="access-form" hidden><div class="eyebrow">Первый вход</div><p class="muted">Введите логин и код из приглашения и придумайте пароль не короче ${MIN_PASSWORD} символов.</p><label for="first-login-name">Логин</label><input id="first-login-name" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="100" required><label for="first-login-code">Код приглашения</label><input id="first-login-code" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" maxlength="40" required><label for="first-login-password">Новый пароль</label><input id="first-login-password" type="password" autocomplete="new-password" minlength="${MIN_PASSWORD}" maxlength="256" required><label for="first-login-repeat">Повторите пароль</label><input id="first-login-repeat" type="password" autocomplete="new-password" maxlength="256" required><p id="first-login-error" class="notice warn" role="alert" hidden></p><button class="btn primary">Задать пароль и войти →</button></form>`;

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
  const showError = errorShower($("#first-login-error"));
  form.onsubmit = async (e) => {
    e.preventDefault();
    const password = $("#first-login-password").value;
    const problem = localProblem(password, $("#first-login-repeat").value);
    if (problem) return showError(problem);
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

const shortDate = (ms, month = "long") =>
  new Date(ms).toLocaleDateString("ru-RU", { day: "numeric", month });
// Окно на общем компоненте подтверждения (dialog.ask): закрывается и удаляется
// целиком, чтобы код приглашения не оставался в разметке.
function modal(html, labelledBy) {
  const dialog = document.createElement("dialog");
  dialog.className = "ask";
  dialog.setAttribute("aria-labelledby", labelledBy);
  dialog.innerHTML = html;
  document.body.append(dialog);
  const close = () => {
    dialog.close();
    dialog.remove();
  };
  dialog.addEventListener("cancel", close);
  dialog.showModal();
  return { dialog, close };
}

// Строка состояния доступа для страницы «Сотрудники».
export function accessLabel(access) {
  if (access.state === "active")
    return (
      "Активен" +
      (access.lastLoginAt
        ? ", вход " + shortDate(Date.parse(access.lastLoginAt), "short")
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
  const letter = inviteLetter(invite, origin);
  const { dialog, close } = modal(
    `<h3 id="invite-title">${invite.reset ? "Пароль сброшен" : "Доступ выдан"}</h3><p>${esc(invite.name)}</p><dl class="invite-code"><dt>Логин</dt><dd id="invite-login">${esc(invite.login)}</dd><dt>Код приглашения</dt><dd id="invite-code">${esc(invite.code)}</dd><dt>Действует до</dt><dd>${esc(shortDate(invite.expires))}</dd></dl><p class="notice warn">Код показывается один раз. После закрытия окна получить его снова нельзя – только выдать новый.</p><label for="invite-letter">Текст письма</label><textarea id="invite-letter" rows="8" readonly>${esc(letter)}</textarea><div class="ask-actions"><button type="button" class="btn" id="invite-copy">Скопировать письмо</button><button type="button" class="btn primary" id="invite-close">Закрыть</button></div>`,
    "invite-title",
  );
  dialog.querySelector("#invite-close").onclick = close;
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

// Смена своего пароля: окно с текущим, новым паролем и повтором.
export function openChangePassword({ api, toast }) {
  const { dialog, close } = modal(
    `<form id="change-password-form" class="access-form"><h3 id="password-title">Смена пароля</h3><label for="password-current">Текущий пароль</label><input id="password-current" type="password" autocomplete="current-password" maxlength="256" required><label for="password-next">Новый пароль</label><input id="password-next" type="password" autocomplete="new-password" minlength="${MIN_PASSWORD}" maxlength="256" required><label for="password-repeat">Повторите новый пароль</label><input id="password-repeat" type="password" autocomplete="new-password" maxlength="256" required><p>После смены журнал закроется на остальных ваших устройствах.</p><p id="password-error" class="notice warn" role="alert" hidden></p><div class="ask-actions"><button type="button" class="btn" id="password-cancel">Отмена</button><button class="btn primary">Сменить пароль</button></div></form>`,
    "password-title",
  );
  const $ = (s) => dialog.querySelector(s);
  const showError = errorShower($("#password-error"));
  $("#password-cancel").onclick = close;
  $("#change-password-form").onsubmit = async (e) => {
    e.preventDefault();
    const next = $("#password-next").value;
    const problem = localProblem(next, $("#password-repeat").value);
    if (problem) return showError(problem);
    showError("");
    try {
      await api("/api/account/password", {
        method: "POST",
        body: JSON.stringify({ current: $("#password-current").value, next }),
      });
      close();
      toast("Пароль изменён");
    } catch (err) {
      showError(err.message);
    }
  };
  return dialog;
}

// День переключения: кнопка режима «только личные пароли» с предпросмотром.
export async function enablePersonalOnly({ api, ask }) {
  const { enabled, withoutPassword } = await api("/api/admin/personal-only");
  if (enabled) return false;
  const confirmed = await ask({
    title: "Включить вход только по личным паролям?",
    text:
      (withoutPassword
        ? `У ${withoutPassword} сотрудников ещё нет личного пароля – после включения они не смогут войти, пока им не выдадут код. `
        : "Личный пароль есть у всех сотрудников. ") +
      "Общий пароль и выбор себя из списка перестанут работать. Вернуть их можно только настройкой на сервере.",
    ok: "Включить",
    danger: true,
  });
  if (!confirmed) return false;
  await api("/api/admin/personal-only", {
    method: "POST",
    body: JSON.stringify({ confirm: true }),
  });
  return true;
}
