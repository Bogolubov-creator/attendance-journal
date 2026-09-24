import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

function page(html) {
  const dom = new JSDOM(`<div id="root">${html}</div>`, {
    url: "http://localhost",
  });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.location = dom.window.location;
  globalThis.FormData = dom.window.FormData;
  return dom;
}
const submit = (form) =>
  form.dispatchEvent(
    new window.Event("submit", { bubbles: true, cancelable: true }),
  );
const tick = () => new Promise((r) => setTimeout(r, 0));

test("Первый вход: форма раскрывается, проверяет повтор и длину, отправляет код и пароль", async () => {
  const { firstLoginHtml, wireFirstLogin } =
    await import("../public/access.js");
  page(firstLoginHtml());
  const requests = [];
  let entered = null;
  let reply = { user: { id: "gadzhieva", role: "admin" } };
  const api = async (path, options) => {
    requests.push({ path, body: JSON.parse(options.body) });
    if (reply instanceof Error) throw reply;
    return reply;
  };
  wireFirstLogin({ api, onLogin: (u) => (entered = u) });
  const $ = (s) => document.querySelector(s);
  assert.equal($("#first-login").hidden, true);
  $("#first-login-open").click();
  assert.equal($("#first-login").hidden, false);
  assert.equal($("#first-login-open").getAttribute("aria-expanded"), "true");

  $("#first-login-name").value = " gadzhieva.ao ";
  $("#first-login-code").value = "ABCD-EFGH-JKLM";
  $("#first-login-password").value = "длинный пароль";
  $("#first-login-repeat").value = "другой пароль";
  submit($("#first-login"));
  await tick();
  assert.equal($("#first-login-error").textContent, "Пароли не совпадают");
  assert.equal(requests.length, 0);

  $("#first-login-password").value = $("#first-login-repeat").value =
    "короткий";
  submit($("#first-login"));
  await tick();
  assert.match($("#first-login-error").textContent, /не короче 10/);
  assert.equal(requests.length, 0);

  reply = new Error("Код не подходит или истёк");
  $("#first-login-password").value = $("#first-login-repeat").value =
    "длинный пароль журнала";
  submit($("#first-login"));
  await tick();
  assert.equal(
    $("#first-login-error").textContent,
    "Код не подходит или истёк",
  );
  assert.equal(entered, null);

  reply = { user: { id: "gadzhieva", role: "admin" } };
  submit($("#first-login"));
  await tick();
  assert.equal(requests.at(-1).path, "/api/first-login");
  assert.deepEqual(requests.at(-1).body, {
    login: "gadzhieva.ao",
    code: "ABCD-EFGH-JKLM",
    password: "длинный пароль журнала",
  });
  assert.equal(entered.id, "gadzhieva");
  assert.equal($("#first-login-error").hidden, true);
});

test("Вход по логину и паролю: отправка с отметкой «Запомнить», ошибка в форме, подсказка «Забыли пароль?»", async () => {
  const { personalLoginHtml, wirePersonalLogin } =
    await import("../public/access.js");
  page(personalLoginHtml());
  const requests = [];
  let entered = null,
    reply = new Error("Неверный логин или пароль");
  const api = async (path, options) => {
    requests.push({ path, body: JSON.parse(options.body) });
    if (reply instanceof Error) throw reply;
    return reply;
  };
  wirePersonalLogin({ api, onLogin: (u) => (entered = u) });
  const $ = (s) => document.querySelector(s);
  assert.equal($("#forgot-text").hidden, true);
  $("#forgot-open").click();
  assert.equal($("#forgot-text").hidden, false);
  assert.match($("#forgot-text").textContent, /менеджеру своей программы/);
  assert.match($("label.check").textContent, /только для преподавателей/);

  $("#personal-login-name").value = " ivanov.ii ";
  $("#personal-login-password").value = "пароль журнала";
  $("#personal-login-remember").checked = true;
  submit($("#personal-login"));
  await tick();
  assert.equal($("#personal-login-error").hidden, false);
  assert.equal(
    $("#personal-login-error").textContent,
    "Неверный логин или пароль",
  );
  assert.equal(entered, null);

  reply = { user: { id: "t1", role: "teacher" } };
  submit($("#personal-login"));
  await tick();
  assert.deepEqual(requests.at(-1), {
    path: "/api/login",
    body: { login: "ivanov.ii", password: "пароль журнала", remember: true },
  });
  assert.equal(entered.id, "t1");
  assert.equal($("#personal-login-error").hidden, true);
});

test("Сотрудники: колонка «Доступ», фильтр «Без доступа», блок офиса, окно с кодом и предложение после добавления", async () => {
  page('<main id="content"></main>');
  const { registryView } = await import("../public/registry.js");
  const now = Date.now();
  let list = [
    {
      id: "t1",
      name: "Иванов Иван Иванович",
      courses: ["Право"],
      students: 3,
      lastMark: null,
      access: {
        state: "active",
        login: "ivanov.ii",
        lastLoginAt: new Date(now).toISOString(),
      },
      canManageAccess: true,
    },
    {
      id: "t2",
      name: "Петров Пётр Петрович",
      courses: ["Логика"],
      students: 1,
      lastMark: null,
      access: {
        state: "invited",
        login: "petrov.pp",
        expires: now + 5 * 86400000,
      },
      canManageAccess: false,
    },
    {
      id: "t3",
      name: "Сидоров Сидор Сидорович",
      courses: [],
      students: 0,
      lastMark: null,
      access: { state: "none", login: null },
      canManageAccess: true,
    },
  ];
  const staff = [
    {
      id: "chinkova",
      name: "Чинкова Алиса Павловна",
      role: "admin",
      access: { state: "none", login: null },
    },
  ];
  const calls = [];
  const asked = [];
  const api = async (path, options = {}) => {
    calls.push({ path, method: options.method || "GET" });
    if (path === "/api/admin/teachers" && !options.method) return list;
    if (path === "/api/admin/staff-access") return staff;
    if (path === "/api/admin/personal-only" && !options.method)
      return { enabled: false, withoutPassword: 2 };
    if (path.startsWith("/api/admin/access/"))
      return {
        name: "Кто-то",
        login: "some.one",
        code: "ABCD-EFGH-JKMN",
        expires: now + 7 * 86400000,
        reset: path.endsWith("t1"),
      };
    if (path === "/api/admin/teachers" && options.method === "POST")
      return { id: "t9", name: "Новиков Николай Николаевич" };
  };
  const ctx = {
    api,
    esc: (s) => String(s),
    toast: () => {},
    ask: async (q) => (asked.push(q.title), true),
    plural: (n) => String(n),
    fmtDate: (d) => d,
    admin: true,
    openStudents: () => {},
  };
  await registryView(ctx);
  const $ = (s) => document.querySelector(s);
  const rows = () => [
    ...document.querySelectorAll("#teacher-rows [data-teacher]"),
  ];
  assert.match(rows()[0].textContent, /Доступ: Активен, вход/);
  assert.match(rows()[1].textContent, /Доступ: Приглашён до/);
  assert.match(rows()[2].textContent, /Доступ: Нет доступа/);
  assert.equal(
    rows()[0].querySelector('[data-action="access"]').textContent,
    "Сбросить пароль",
  );
  assert.equal(
    rows()[1].querySelector('[data-action="access"]'),
    null,
    "без права – без кнопки",
  );
  assert.equal(
    rows()[2].querySelector('[data-action="access"]').textContent,
    "Выдать доступ",
  );
  assert.match($("#staff-access").textContent, /Чинкова Алиса Павловна/);

  $("#teacher-no-access").click();
  assert.deepEqual(
    rows().map((r) => r.dataset.teacher),
    ["t2", "t3"],
  );
  $("#teacher-no-access").click();

  // Сброс спрашивает подтверждение и показывает код один раз.
  rows()[0].querySelector('[data-action="access"]').click();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(asked.at(-1), "Сбросить пароль?");
  let dialog = document.querySelector("dialog.ask");
  assert.match(dialog.textContent, /Пароль сброшен/);
  assert.equal(
    dialog.querySelector("#invite-code").textContent,
    "ABCD-EFGH-JKMN",
  );
  assert.match(
    dialog.querySelector("#invite-letter").value,
    /Логин: some\.one/,
  );
  assert.match(
    dialog.querySelector("#invite-letter").value,
    /Первый вход по коду приглашения/,
  );
  dialog.querySelector("#invite-close").click();
  assert.equal(
    document.querySelector("dialog.ask"),
    null,
    "код не остаётся на странице",
  );

  // После добавления преподавателя – предложение выдать доступ.
  $("#teacher-add input").value = "Новиков Николай Николаевич";
  $("#teacher-add").dispatchEvent(
    new window.Event("submit", { cancelable: true }),
  );
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(asked.at(-1), "Выдать доступ новому преподавателю?");
  assert.ok(
    calls.some((c) => c.path === "/api/admin/access/t9" && c.method === "POST"),
  );
  dialog = document.querySelector("dialog.ask");
  assert.match(dialog.textContent, /Доступ выдан/);
});

test("Выгрузка кодов: сначала предупреждение, без согласия запроса нет", async () => {
  page("");
  const { exportInvites } = await import("../public/access.js");
  const realFetch = globalThis.fetch;
  const fetched = [];
  let clicked = 0;
  globalThis.fetch = async (path, options) => {
    fetched.push({ path, method: options.method });
    return new Response("\uFEFFФИО", { status: 200 });
  };
  globalThis.URL.createObjectURL = () => "blob:codes";
  globalThis.URL.revokeObjectURL = () => {};
  window.HTMLAnchorElement.prototype.click = () => clicked++;
  try {
    const titles = [];
    let answer = false;
    const ask = async (q) => (titles.push(q), answer);
    assert.equal(await exportInvites({ ask }), false);
    assert.equal(fetched.length, 0);
    assert.match(titles[0].text, /удалите его сразу после рассылки/);
    answer = true;
    assert.equal(await exportInvites({ ask }), true);
    assert.deepEqual(fetched, [
      { path: "/api/admin/access-export", method: "POST" },
    ]);
    assert.equal(clicked, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Смена пароля: окно проверяет повтор, показывает ошибку сервера и закрывается после успеха", async () => {
  page("");
  const { openChangePassword } = await import("../public/access.js");
  let reply = new Error("Текущий пароль указан неверно");
  const requests = [],
    toasts = [];
  const api = async (path, options) => {
    requests.push({ path, body: JSON.parse(options.body) });
    if (reply instanceof Error) throw reply;
    return reply;
  };
  const dialog = openChangePassword({ api, toast: (m) => toasts.push(m) });
  const $ = (s) => dialog.querySelector(s);
  $("#password-current").value = "старый пароль";
  $("#password-next").value = "новый пароль журнала";
  $("#password-repeat").value = "другой";
  submit($("#change-password-form"));
  await tick();
  assert.equal($("#password-error").textContent, "Пароли не совпадают");
  assert.equal(requests.length, 0);

  $("#password-repeat").value = "новый пароль журнала";
  submit($("#change-password-form"));
  await tick();
  assert.equal(
    $("#password-error").textContent,
    "Текущий пароль указан неверно",
  );

  reply = { ok: true };
  submit($("#change-password-form"));
  await tick();
  assert.deepEqual(requests.at(-1), {
    path: "/api/account/password",
    body: { current: "старый пароль", next: "новый пароль журнала" },
  });
  assert.equal(document.querySelector("#change-password-form"), null);
  assert.deepEqual(toasts, ["Пароль изменён"]);
});

test("День X: предупреждение с числом сотрудников без пароля, без согласия режим не включается", async () => {
  page("");
  const { enablePersonalOnly } = await import("../public/access.js");
  const calls = [];
  let enabled = false,
    answer = false;
  const api = async (path, options = {}) => {
    calls.push({ path, method: options.method || "GET", body: options.body });
    return { enabled, withoutPassword: 7 };
  };
  const questions = [];
  const ask = async (q) => (questions.push(q), answer);
  assert.equal(await enablePersonalOnly({ api, ask }), false);
  assert.match(questions[0].text, /У 7 сотрудников ещё нет личного пароля/);
  assert.equal(questions[0].danger, true);
  assert.ok(!calls.some((c) => c.method === "POST"));
  answer = true;
  assert.equal(await enablePersonalOnly({ api, ask }), true);
  assert.deepEqual(calls.at(-1), {
    path: "/api/admin/personal-only",
    method: "POST",
    body: JSON.stringify({ confirm: true }),
  });
  enabled = true;
  const asked = questions.length;
  assert.equal(await enablePersonalOnly({ api, ask }), false);
  assert.equal(questions.length, asked, "уже включён – не спрашивает");
});
