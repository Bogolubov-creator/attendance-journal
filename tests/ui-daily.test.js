import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

test("Форма журнала: смена пользователя, блокировка сохранения и восстановление после конфликта", async () => {
  const dom = new JSDOM('<main id="content"></main>', {
    url: "http://localhost",
  });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.confirm = () => true;
  const daily = await import("../public/daily.js");
  let requests = [],
    release,
    conflict = false;
  let course = "Право";
  const api = async (path, options) => {
    requests.push({ path, options });
    if (options?.method === "PUT") {
      if (conflict) throw Object.assign(new Error("Конфликт"), { status: 409 });
      return new Promise((r) => (release = () => r({ version: 1 })));
    }
    return {
      course,
      courses: [course, "Логика"],
      students: [{ id: "s1", name: "Студент" }],
      marks: [],
      version: 0,
    };
  };
  const ctx = { api, esc: (s) => s, toast: () => {} };
  try {
    await daily.dailyJournal(ctx);
    document.querySelector('[data-status="present"]').click();
    assert.equal(daily.hasDailyChanges(), true);
    const saving = document.querySelector("#daily-save").onclick();
    assert.equal(daily.isDailySaving(), true);
    assert.equal(document.querySelector("#daily-course").disabled, true);
    assert.equal(document.querySelector("#daily-date").disabled, true);
    release();
    await saving;
    assert.equal(daily.hasDailyChanges(), false);
    assert.equal(daily.isDailySaving(), false);
    assert.equal(document.querySelector("#daily-course").disabled, false);
    conflict = true;
    document.querySelector('[data-status="absent"]').click();
    await document.querySelector("#daily-save").onclick();
    assert.equal(daily.hasDailyChanges(), true);
    const reload = [...document.querySelectorAll("button")].find(
      (b) => b.textContent === "Загрузить сохранённые отметки",
    );
    assert.equal(reload.hidden, false);
    await reload.onclick();
    assert.equal(daily.hasDailyChanges(), false);
    // Новый пользователь имеет другой набор дисциплин.
    daily.resetDailySession();
    course = "История";
    requests = [];
    await daily.dailyJournal(ctx);
    assert.equal(
      new URL(requests[0].path, "http://localhost").searchParams.has("course"),
      false,
    );
    assert.equal(document.querySelector("#daily-course").value, "История");
  } finally {
    dom.window.close();
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.confirm;
  }
});

test("Дашборд: счётчик тревог, фильтр, поиск и отсутствие ложной тревоги на седьмой день", async () => {
  const dom = new JSDOM('<main id="content"></main>', {
    url: "http://localhost",
  });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  const { dailyDashboard } = await import("../public/daily.js");
  const students = [
    {
      id: "a",
      name: "Студент Восемь",
      status: "unknown",
      absenceAlert: true,
      absenceDays: 8,
      daysPresent: 0,
      history: [],
    },
    {
      id: "b",
      name: "Студент Семь",
      status: "absent",
      absenceAlert: false,
      absenceDays: 7,
      daysPresent: 0,
      history: [],
    },
    {
      id: "c",
      name: "Без Отметок",
      status: "unknown",
      absenceAlert: false,
      absenceDays: 0,
      daysPresent: 0,
      history: [],
    },
  ];
  try {
    await dailyDashboard({
      api: async () => ({ students }),
      esc: (s) => s,
      toast: () => {},
    });
    assert.match(
      document.querySelector(".absence-notice").textContent,
      /Тревоги на сегодня: 1/,
    );
    assert.equal(
      document.querySelectorAll(".daily-person.has-alert").length,
      1,
    );
    document.querySelector("#show-absence-alerts").click();
    assert.equal(document.querySelectorAll(".daily-person").length, 1);
    assert.match(
      document.querySelector("#daily-results").textContent,
      /Студент Восемь/,
    );
    const search = document.querySelector("#daily-search");
    search.value = "несуществующий";
    search.oninput();
    assert.match(
      document.querySelector("#daily-results").textContent,
      /Студенты не найдены/,
    );
  } finally {
    dom.window.close();
    delete globalThis.window;
    delete globalThis.document;
  }
});
