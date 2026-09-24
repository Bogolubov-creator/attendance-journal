// Страховка для правок скорости: «Моя посещаемость» студента, сводка и выгрузка
// «Посещаемость по дате» на базе с отметками разных студентов, дат и источников
// сверяются с эталоном целиком. Отметки до периода влияют на последнее посещение.
// Эталон пересоздаётся только осознанно: UPDATE_SNAPSHOT=1 node --test tests/daily-snapshot.test.js
import { passwordHash } from "../src/management-auth.js";
import test from "node:test";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const snapshotPath = "tests/fixtures/daily-snapshot.json";
const students = [
  ["s_a", "Яковлев Иван"],
  ["s_b", "Ёлкина Мария"],
  ["s_c", "Елисеев Пётр"],
  ["s_d", "абрамова Анна"],
  ["s_e", "Жуков Олег"],
].map(([id, name]) => ({ id, name }));
const teachers = [
  ["t_1", "Щукин Борис"],
  ["t_2", "Ёжиков Лев"],
  ["t_3", "Ежов Глеб"],
].map(([id, name]) => ({ id, name }));
const link = (studentId, teacherId, course) => ({
  studentId,
  teacherId,
  group: "Г-1",
  course,
  kind: "Семинар",
});
const enrollments = [
  link("s_a", "t_1", "Право"),
  link("s_b", "t_1", "Право"),
  link("s_a", "t_2", "Экономика"),
  link("s_c", "t_2", "Арбитраж"),
  link("s_d", "t_3", "История"),
  link("s_e", "t_3", "История"),
];
const periods = [
  ["2026-09-01", "2026-09-20"],
  ["2026-09-03", "2026-09-05"],
  ["2026-09-06", "2026-09-06"],
  ["2026-07-01", "2026-07-31"],
];

test("«Моя посещаемость» и сводка по датам совпадают с эталоном", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "attendance-daily-snapshot-")),
    origin = "http://127.0.0.1:3153",
    dbPath = join(tmp, "db.sqlite"),
    rosterPath = join(tmp, "roster.json");
  writeFileSync(
    rosterPath,
    JSON.stringify({ students, teachers, enrollments, quality: {} }),
  );
  const child = spawn(process.execPath, ["src/server.js"], {
    env: {
      ...process.env,
      ROSTER_PATH: rosterPath,
      MANAGEMENT_PASSWORD_HASH: passwordHash("test-management-password"),
      DEMO_MODE: "true",
      AUTH_MODE: "selection",
      AUTO_BACKUP: "false",
      DB_PATH: dbPath,
      PORT: "3153",
      APP_ORIGIN: origin,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    child.stdout.once("data", resolve);
    child.once("error", reject);
    child.once("exit", (c) => reject(Error("exit " + c)));
  });
  let cookie = "";
  const req = (route, method = "GET", body) =>
    fetch(origin + route, {
      method,
      headers: { origin, "content-type": "application/json", cookie },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const get = async (route) => {
    const r = await req(route);
    assert.equal(r.status, 200, route);
    return r;
  };
  const login = async (body) => {
    const r = await req("/api/demo-login", "POST", {
      ...body,
      password: "test-management-password",
    });
    assert.equal(r.status, 200);
    cookie = r.headers.get("set-cookie").split(";")[0];
  };
  try {
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA busy_timeout=5000");
    const daily = db.prepare(
      "INSERT INTO daily_marks VALUES(?,?,?,?,?,'2026-09-01T10:00:00.000Z')",
    );
    // Одинаковые даты у разных дисциплин и источников – проверка порядка при равных датах.
    for (const [t, date, course, s, status] of [
      ["t_1", "2026-08-25", "Право", "s_b", "present"],
      ["t_1", "2026-09-02", "Право", "s_a", "present"],
      ["t_1", "2026-09-02", "Право", "s_b", "absent"],
      ["t_2", "2026-09-02", "Экономика", "s_a", "absent"],
      ["t_1", "2026-09-03", "Право", "s_a", "absent"],
      ["t_1", "2026-09-03", "Право", "s_b", "absent"],
      ["t_2", "2026-09-04", "Арбитраж", "s_c", "present"],
      ["t_2", "2026-09-04", "Экономика", "s_a", "present"],
      ["t_1", "2026-09-05", "Право", "s_a", "present"],
      ["t_3", "2026-09-05", "История", "s_e", "absent"],
      ["t_2", "2026-09-06", "Экономика", "s_a", "absent"],
      ["t_3", "2026-09-06", "История", "s_d", "absent"],
    ])
      daily.run(t, date, course, s, status);
    for (let d = 7; d <= 16; d++)
      daily.run(
        "t_1",
        `2026-09-${String(d).padStart(2, "0")}`,
        "Право",
        "s_b",
        "absent",
      );
    const lesson = db.prepare("INSERT INTO lessons VALUES(?,?,?)"),
      mark = db.prepare(
        "INSERT INTO marks VALUES(?,?,?,'','2026-08-01T10:00:00.000Z')",
      );
    for (const [id, t, date, course] of [
      ["l_1", "t_1", "2026-09-02", "Право"],
      ["l_2", "t_3", "2026-08-30", "История"],
      ["l_3", "t_3", "2026-09-05", "История"],
    ])
      lesson.run(id, t, JSON.stringify({ id, teacherId: t, date, course }));
    mark.run("l_1", "s_a", "absent");
    mark.run("l_1", "s_b", "present");
    mark.run("l_2", "s_d", "present");
    mark.run("l_2", "s_e", "absent");
    mark.run("l_3", "s_e", "present");
    db.close();

    // Тревога считается на сегодня: дата из ответа не входит в эталон.
    const overview = ({ alertAsOf, ...o }) => o;
    const actual = { overview: {}, export: {}, student: {} };
    await login({ role: "admin" });
    for (const [from, to] of periods) {
      const q = `?from=${from}&to=${to}`;
      actual.overview[q] = overview(
        await (await get("/api/daily/overview" + q)).json(),
      );
      actual.export[q] = await (await get("/api/daily/export" + q)).text();
    }
    for (const s of students) {
      await login({ role: "student", studentId: s.id });
      actual.student[s.id] = {};
      for (const [from, to] of periods) {
        const q = `?from=${from}&to=${to}`;
        actual.student[s.id][q] = await (
          await get("/api/student/attendance" + q)
        ).json();
      }
    }

    if (process.env.UPDATE_SNAPSHOT)
      writeFileSync(snapshotPath, JSON.stringify(actual, null, 2) + "\n");
    assert.deepEqual(actual, JSON.parse(readFileSync(snapshotPath, "utf8")));
  } finally {
    child.kill();
    rmSync(tmp, { recursive: true, force: true });
  }
});
