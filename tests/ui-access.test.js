import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

function page(html) {
  const dom = new JSDOM(`<div id="root">${html}</div>`, {
    url: "http://localhost",
  });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
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
