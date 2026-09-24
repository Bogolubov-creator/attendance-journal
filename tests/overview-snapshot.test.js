// Страховка для правок скорости: содержимое обзора, карточек и списка преподавателей
// на базе с отметками и задолженностями сверяется с эталоном целиком, с порядком строк.
// Эталон пересоздаётся только осознанно: UPDATE_SNAPSHOT=1 node --test tests/overview-snapshot.test.js
import { passwordHash } from "../src/management-auth.js";
import test from "node:test";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const snapshotPath = "tests/fixtures/overview-snapshot.json";
const students = [
  ["s_a", "Яковлев Иван"],
  ["s_b", "Ёлкина Мария"],
  ["s_c", "Елисеев Пётр"],
  ["s_d", "абрамова Анна"],
  ["s_e", "Жуков Олег"],
  ["s_f", "Zhang Wei"],
].map(([id, name]) => ({ id, name }));
const teachers = [
  ["t_1", "Щукин Борис"],
  ["t_2", "Ёжиков Лев"],
  ["t_3", "Ежов Глеб"],
  ["t_4", "Вак_Без Связей"],
].map(([id, name]) => ({ id, name }));
const link = (studentId, teacherId, group, course) => ({
  studentId,
  teacherId,
  group,
  course,
  kind: "Семинар",
});
const enrollments = [
  link("s_a", "t_1", "Г-1", "Право"),
  link("s_b", "t_1", "Г-1", "Право"),
  link("s_a", "t_2", "Г-2", "Экономика"),
  link("s_a", "t_2", "Г-3", "Экономика"),
  link("s_c", "t_2", "Г-2", "Ёмкость"),
  link("s_c", "t_2", "Г-2", "Арбитраж"),
  link("s_d", "t_3", "Г-4", "История"),
  link("s_e", "t_3", "Г-4", "История"),
  link("s_e", "t_1", "Г-1", "Логика"),
  link("s_f", "t_1", "Г-1", "право"),
];

test("Обзор, карточки и список преподавателей совпадают с эталоном", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "attendance-snapshot-")),
    origin = "http://127.0.0.1:3151",
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
      PORT: "3151",
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
  const json = async (route) => {
    const r = await req(route);
    assert.equal(r.status, 200, route);
    return r.json();
  };
  const login = async (role, personId) => {
    const r = await req("/api/select-login", "POST", {
      role,
      personId,
      password: "test-management-password",
    });
    assert.equal(r.status, 200);
    cookie = r.headers.get("set-cookie").split(";")[0];
  };
  try {
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA busy_timeout=5000");
    const profile = db.prepare(
      "INSERT OR REPLACE INTO student_profiles VALUES(?,?)",
    );
    for (const [id, program, year] of [
      ["s_a", "Юриспруденция", 2],
      ["s_b", "Юриспруденция", 2],
      ["s_c", "Право", 4],
      ["s_e", "Юриспруденция", 2],
    ])
      profile.run(
        id,
        JSON.stringify({
          version: 1,
          program,
          year,
          foreignStatus: "confirmed",
        }),
      );
    const daily = db.prepare(
      "INSERT INTO daily_marks VALUES(?,?,?,?,?,'2026-09-01T10:00:00.000Z')",
    );
    // Одинаковые даты у разных дисциплин и источников – проверка порядка при равных датах.
    for (const [t, date, course, s, status] of [
      ["t_1", "2026-09-02", "Право", "s_a", "present"],
      ["t_1", "2026-09-02", "Право", "s_b", "absent"],
      ["t_2", "2026-09-02", "Экономика", "s_a", "absent"],
      ["t_1", "2026-09-03", "Право", "s_a", "absent"],
      ["t_1", "2026-09-03", "Право", "s_b", "absent"],
      ["t_2", "2026-09-04", "Ёмкость", "s_c", "present"],
      ["t_2", "2026-09-04", "Арбитраж", "s_c", "absent"],
      ["t_1", "2026-09-05", "Право", "s_a", "present"],
      ["t_3", "2026-09-05", "История", "s_e", "absent"],
      ["t_1", "2026-09-06", "Логика", "s_e", "absent"],
      ["t_2", "2026-09-06", "Экономика", "s_a", "present"],
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
    ]) {
      lesson.run(id, t, JSON.stringify({ id, teacherId: t, date, course }));
    }
    mark.run("l_1", "s_a", "absent");
    mark.run("l_1", "s_b", "present");
    mark.run("l_2", "s_d", "present");
    mark.run("l_2", "s_e", "absent");
    const debt = db.prepare("INSERT INTO debts VALUES(?,?,?,?,?)");
    debt.run("d_1", "s_b", "Эссе", 0, "2026-09-03T10:00:00.000Z");
    debt.run("d_2", "s_b", "Тест", 1, "2026-09-04T10:00:00.000Z");
    debt.run("d_3", "s_e", "Реферат", 0, "2026-09-05T10:00:00.000Z");
    db.close();

    await login("admin", "gadzhieva");
    // Сначала читаем список, потом правим связи: ответы должны учесть правку.
    await json("/api/admin/teachers");
    await json("/api/admin/overview");
    for (const [method, body] of [
      ["POST", { studentId: "s_d", teacherId: "t_1", course: "Право" }],
      [
        "POST",
        { studentId: "s_f", teacherId: "t_3", course: "Ёмкость", group: "Г-9" },
      ],
      [
        "DELETE",
        { studentId: "s_e", teacherId: "t_1", course: "Логика", group: "Г-1" },
      ],
    ])
      assert.equal(
        (await req("/api/admin/enrollments", method, body)).status,
        200,
      );

    // Время записи журнала изменений от прогона к прогону разное.
    const overview = (o) => ({
      ...o,
      audit: o.audit.map(({ at, ...a }) => a),
    });
    const actual = { admin: {}, office: {} };
    actual.admin.overview = overview(await json("/api/admin/overview"));
    actual.admin.teachers = await json("/api/admin/teachers");
    actual.admin.cards = {};
    for (const s of students)
      actual.admin.cards[s.id] = await json("/api/admin/students/" + s.id);
    await login("office", "smirnova");
    actual.office.overview = overview(await json("/api/admin/overview"));
    actual.office.card = await json("/api/admin/students/s_a");
    assert.equal((await req("/api/admin/students/s_c")).status, 403);
    assert.equal((await req("/api/admin/students/s_zzz")).status, 404);

    if (process.env.UPDATE_SNAPSHOT)
      writeFileSync(snapshotPath, JSON.stringify(actual, null, 2) + "\n");
    assert.deepEqual(actual, JSON.parse(readFileSync(snapshotPath, "utf8")));
  } finally {
    child.kill();
    rmSync(tmp, { recursive: true, force: true });
  }
});
