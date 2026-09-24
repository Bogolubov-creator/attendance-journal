import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

test("Общий файл интерфейса: экранирование, размер файла, подписи", async () => {
  const core = await import("../public/ui-core.js");
  assert.equal(
    core.esc(`<a href="x">'&`),
    "&lt;a href=&quot;x&quot;&gt;&#39;&amp;",
  );
  assert.equal(core.esc(null), "");
  assert.equal(core.fmtSize(2048), "2 КБ");
  assert.equal(core.fmtSize(3 * 1024 * 1024), "3.0 МБ");
  assert.equal(core.procedureLabels.expired, "Истёк срок действия");
  assert.equal(core.residenceLabels.residence_permit, "ВНЖ");
});

test("Общий запрос к API: 401 уходит в обработчик вызывающего", async () => {
  const { createApi } = await import("../public/ui-core.js");
  const realFetch = globalThis.fetch;
  let unauthorized = 0;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: "Войдите" }), { status: 401 });
  try {
    const api = createApi(() => unauthorized++);
    await assert.rejects(api("/api/x"), { message: "Войдите", status: 401 });
    assert.equal(unauthorized, 1);
    globalThis.fetch = async () => new Response(JSON.stringify({ ok: 1 }));
    assert.deepEqual(await api("/api/x"), { ok: 1 });
    assert.equal(unauthorized, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Общее уведомление: ошибка остаётся с кнопкой закрытия", async () => {
  const dom = new JSDOM('<div id="toast"></div>', { url: "http://localhost" });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  const { toast, safe } = await import("../public/ui-core.js");
  await safe(async () => {
    throw Error("Сбой <b>");
  });
  const el = document.querySelector("#toast");
  assert.equal(el.getAttribute("role"), "alert");
  assert.match(el.innerHTML, /Сбой &lt;b&gt;/);
  assert.ok(el.querySelector(".toast-close"));
  toast("Сохранено");
  assert.equal(el.className, "show");
});

test("Журнал и кабинет берут служебные функции и подписи из общего файла", () => {
  for (const file of ["public/app.js", "public/student.js"]) {
    const src = readFileSync(file, "utf8");
    assert.ok(src.includes('from "./ui-core.js"'), `${file}: нет импорта`);
    assert.ok(!/async function api\b/.test(src), `${file}: своя копия api`);
    for (const name of [
      "esc",
      "fmtSize",
      "toast",
      "safe",
      "procedureLabels",
      "foreignStatusLabels",
      "enrollmentStatusLabels",
      "residenceLabels",
      "inRussiaLabels",
      "housingLabels",
    ])
      assert.ok(
        !new RegExp(`(const|function)\\s+${name}\\b`).test(src),
        `${file}: своя копия ${name}`,
      );
  }
});

test("Реестр: «Занятия: N» подгружает занятия студента один раз, повторный клик сворачивает", async () => {
  const dom = new JSDOM(
    '<table><tr><td><button data-records="s 1" aria-expanded="false">Занятия: 2</button></td></tr><tr class="records-row" id="records-s 1" hidden><td colspan="4"></td></tr></table>',
    { url: "http://localhost" },
  );
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  const { toggleRecords } = await import("../public/ui-core.js");
  const requests = [];
  let answer;
  const api = (path) => {
    requests.push(path);
    return new Promise((resolve, reject) => (answer = { resolve, reject }));
  };
  const render = (records) =>
    records.map((r) => `<div class="record">${r.course}</div>`).join("");
  const button = document.querySelector("[data-records]"),
    row = document.getElementById("records-s 1");
  button.onclick = () => toggleRecords(button, { api, render });

  // Ошибка: понятный текст в строке, следующее раскрытие пробует снова.
  button.click();
  assert.equal(row.hidden, false);
  assert.equal(row.textContent, "Загрузка…");
  answer.reject(Error("Студент не относится к вашим программам и курсам"));
  await new Promise((r) => setTimeout(r));
  assert.match(row.textContent, /не относится к вашим программам/);
  button.click();
  assert.equal(row.hidden, true);

  button.click();
  assert.deepEqual(requests, [
    "/api/admin/students/s%201",
    "/api/admin/students/s%201",
  ]);
  assert.equal(button.getAttribute("aria-expanded"), "true");
  answer.resolve({ records: [{ course: "Право" }, { course: "Логика" }] });
  await new Promise((r) => setTimeout(r));
  assert.equal(row.querySelectorAll(".record").length, 2);
  assert.match(row.textContent, /Право.*Логика/);

  // Свернуть и раскрыть снова – без нового запроса, с теми же занятиями.
  button.click();
  assert.equal(row.hidden, true);
  assert.equal(button.getAttribute("aria-expanded"), "false");
  button.click();
  assert.equal(row.hidden, false);
  assert.equal(row.querySelectorAll(".record").length, 2);
  assert.equal(requests.length, 2);
});

test("Реестр подгружает занятия через общий toggleRecords, а не из обзора", () => {
  const src = readFileSync("public/app.js", "utf8");
  assert.ok(/toggleRecords\(/.test(src));
  assert.ok(!/s\.records\b/.test(src));
});
