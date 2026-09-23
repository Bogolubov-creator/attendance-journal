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
