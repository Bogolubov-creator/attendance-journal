import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  createScheduler,
  retryDelay,
  resolveTeacherEmail,
} from "../src/scheduler.js";
test("Очередь сохраняет успех и повтор после рестарта", async () => {
  const db = new DatabaseSync(":memory:");
  let now = 100000,
    calls = 0;
  const options = {
    db,
    teacherIds: ["t"],
    now: () => now,
    intervalMs: 1000,
    syncTeacher: async () => {
      calls++;
    },
  };
  const a = createScheduler(options);
  assert.equal(await a.tick(), true);
  assert.equal(await a.tick(), false);
  assert.equal(calls, 1);
  const b = createScheduler(options);
  assert.equal(await b.tick(), false);
  now += 1000;
  await b.tick();
  assert.equal(calls, 2);
  db.close();
});
test("Ошибка сохраняется и повторяется с задержкой", async () => {
  const db = new DatabaseSync(":memory:");
  let now = 100000;
  const s = createScheduler({
    db,
    teacherIds: ["t"],
    now: () => now,
    syncTeacher: async () => {
      throw Object.assign(Error("Недоступно"), { status: 502 });
    },
  });
  await s.tick();
  assert.equal(s.state()[0].failures, 1);
  assert.equal(s.state()[0].error, "Недоступно");
  assert.equal(await s.tick(), false);
  now += 60000;
  await s.tick();
  assert.equal(s.state()[0].failures, 2);
  assert.equal(s.state()[0].nextRun, now + 120000);
  db.close();
});
test("Одновременные тики не запускают параллельный запрос", async () => {
  const db = new DatabaseSync(":memory:");
  let release,
    calls = 0;
  const s = createScheduler({
    db,
    teacherIds: ["t"],
    syncTeacher: async () => {
      calls++;
      await new Promise((r) => (release = r));
    },
  });
  const p = s.tick();
  assert.equal(await s.tick(), false);
  release();
  await p;
  assert.equal(calls, 1);
  db.close();
});
test("Неоднозначное ФИО повторяется через сутки", () =>
  assert.equal(retryDelay(1, true), 86400000));
test("Почта только точного преподавателя, без подмены коллегой", () => {
  assert.equal(
    resolveTeacherEmail(
      [
        {
          lecturer: "Иванов Иван",
          lecturerEmail: "ivanov@hse.ru",
          listOfLecturers: [
            { lecturer: "Петров Пётр", lecturerEmail: "petrov@hse.ru" },
          ],
        },
      ],
      "Иванов Иван",
    ),
    "ivanov@hse.ru",
  );
  assert.equal(
    resolveTeacherEmail(
      [{ lecturer: "Другой", lecturerEmail: "ivanov@hse.ru" }],
      "Иванов Иван",
    ),
    null,
  );
  assert.equal(
    resolveTeacherEmail(
      [
        { lecturer: "Иванов Иван", lecturerEmail: "a@hse.ru" },
        { lecturer: "Иванов Иван", lecturerEmail: "b@hse.ru" },
      ],
      "Иванов Иван",
    ),
    null,
  );
  assert.equal(
    resolveTeacherEmail(
      [{ lecturer: "Иванов Иван", lecturerEmail: "a@hse.ru.evil.example" }],
      "Иванов Иван",
    ),
    null,
  );
});
