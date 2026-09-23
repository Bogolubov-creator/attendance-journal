import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

test("Кабинет: требования, свои поля и посещаемость", async () => {
  const dom = new JSDOM('<main id="content"></main>', {
    url: "http://localhost",
  });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  const student = await import("../public/student.js");
  const api = async (path) => {
    if (path.startsWith("/api/student/requirements"))
      return {
        requirements: [
          {
            id: "registration",
            title: "Миграционный учёт",
            hint: "Проверить основание пребывания",
            source: "https://ivisa.hse.ru/",
            closedBy: "staff",
            state: "unknown",
            status: "unknown",
            version: 0,
            attachments: [],
          },
        ],
      };
    if (path.startsWith("/api/student/profile"))
      return {
        student: {
          name: "Студент Первый",
          citizenship: "",
          program: "Право",
          version: 0,
        },
        editable: ["citizenship"],
      };
    return { absenceDays: 2, lastVisit: "2026-09-22", days: [] };
  };
  const esc = (s) => String(s);
  document.querySelector("#content").innerHTML =
    await student.renderRequirements({ api, esc });
  assert.match(document.body.textContent, /Миграционный учёт/);
  // Политика видна студенту: он знает, что будет после сохранения.
  assert.match(document.body.textContent, /на проверку/i);

  document.querySelector("#content").innerHTML = await student.renderProfile({
    api,
    esc,
  });
  const program = document.querySelector('[name="program"]');
  assert.ok(!program || program.disabled, "учебное поле должно быть закрыто");
});

test("Требование: подпись политики для обоих значений closedBy, «не требуется» студенту не предлагается", async () => {
  const dom = new JSDOM('<main id="content"></main>', {
    url: "http://localhost",
  });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  const student = await import("../public/student.js");
  const esc = (s) => String(s);
  const base = {
    title: "Требование",
    hint: "Подсказка",
    source: "https://example.test/",
    state: "pending",
    status: "pending",
    version: 0,
    attachments: [],
  };
  const api = async () => ({
    requirements: [
      { ...base, id: "staffOne", closedBy: "staff" },
      { ...base, id: "studentOne", closedBy: "student" },
    ],
  });
  document.querySelector("#content").innerHTML =
    await student.renderRequirements({ api, esc });
  const text = document.body.textContent;
  assert.match(text, /уйдут на проверку в учебный офис/i);
  assert.match(text, /будет отмечено выполненным/i);
  // Освобождение от требования доступно только сотруднику – студент такой
  // выбор нигде не видит, ни в тексте, ни в форме.
  assert.doesNotMatch(text, /не требуется/i);
  assert.equal(document.querySelectorAll('option[value="exempt"]').length, 0);
});

test("Мои данные: нередактируемое поле заблокировано и подписано, редактируемое доступно", async () => {
  const dom = new JSDOM('<main id="content"></main>', {
    url: "http://localhost",
  });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  const student = await import("../public/student.js");
  const esc = (s) => String(s);
  const api = async () => ({
    student: {
      name: "Студент Второй",
      program: "Юриспруденция",
      year: 2,
      citizenship: "Сербия",
      version: 3,
    },
    editable: ["citizenship"],
  });
  document.querySelector("#content").innerHTML = await student.renderProfile({
    api,
    esc,
  });
  const program = document.querySelector('[name="program"]');
  assert.equal(program.disabled, true);
  assert.match(program.closest("label").textContent, /меняет учебный офис/);
  const citizenship = document.querySelector('[name="citizenship"]');
  assert.equal(citizenship.disabled, false);
  assert.doesNotMatch(
    citizenship.closest("label").textContent,
    /меняет учебный офис/,
  );
});

test("Кнопка «Удалить» скана следует правилу сервера, а не блокировке формы", async () => {
  // Сервер (DELETE /api/student/attachments/:id, src/student.js) отказывает
  // только когда state==="confirmed" – независимо от closedBy. У требования
  // с closedBy:"student" форма редактирования остаётся открытой и при
  // state:"confirmed" (студент может исправить и подтвердить заново), но
  // приложенный скан удалить уже нельзя – кнопки быть не должно.
  const dom = new JSDOM('<main id="content"></main>', {
    url: "http://localhost",
  });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  const student = await import("../public/student.js");
  const esc = (s) => String(s);
  const base = {
    id: "insurance",
    title: "Требование",
    hint: "Подсказка",
    source: "https://example.test/",
    closedBy: "student",
    version: 0,
    attachments: [
      {
        id: "a1",
        fileName: "скан.pdf",
        size: 1024,
        uploadedAt: "2026-09-20T10:00:00.000Z",
      },
    ],
  };
  const confirmed = await student.renderRequirements({
    api: async () => ({
      requirements: [{ ...base, state: "confirmed", status: "confirmed" }],
    }),
    esc,
  });
  document.querySelector("#content").innerHTML = confirmed;
  assert.equal(
    document.querySelectorAll("[data-delete-attachment]").length,
    0,
    "подтверждённый скан студент удалить не может – кнопки быть не должно",
  );

  const submitted = await student.renderRequirements({
    api: async () => ({
      requirements: [{ ...base, state: "submitted", status: "submitted" }],
    }),
    esc,
  });
  document.querySelector("#content").innerHTML = submitted;
  assert.equal(
    document.querySelectorAll("[data-delete-attachment]").length,
    1,
    "требование на проверке ещё не подтверждено – кнопка должна быть видна",
  );
});

test("Моя посещаемость: сводка и дни без имён преподавателей", async () => {
  const dom = new JSDOM('<main id="content"></main>', {
    url: "http://localhost",
  });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  const student = await import("../public/student.js");
  const esc = (s) => String(s);
  const api = async () => ({
    absenceDays: 5,
    lastVisit: "2026-09-20",
    days: [
      {
        date: "2026-09-19",
        marks: [{ course: "Право", status: "present" }],
      },
    ],
  });
  document.querySelector("#content").innerHTML = await student.renderAttendance(
    { api, esc },
  );
  const text = document.body.textContent;
  assert.match(text, /Не были 5 учебных дней/);
  assert.match(text, /20\.09\.2026/);
  assert.match(text, /Право/);
  assert.doesNotMatch(text, /Преподаватель/);
});
