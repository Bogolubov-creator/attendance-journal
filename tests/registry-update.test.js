import { passwordHash } from "../src/management-auth.js";
import { moscowDate } from "../src/domain.js";
import test from "node:test";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { workbook } from "./fixtures/zip.js";

test("Обновление реестра из Excel, преподаватели без отметок и перевод на следующий курс", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "attendance-update-")),
    origin = "http://127.0.0.1:3108";
  const env = {
    ...process.env,
    ROSTER_PATH: "tests/fixtures/roster.json",
    MANAGEMENT_PASSWORD_HASH: passwordHash("test-management-password"),
    DEMO_MODE: "true",
    AUTH_MODE: "selection",
    AUTO_BACKUP: "false",
    DB_PATH: join(tmp, "db.sqlite"),
    PORT: "3108",
    APP_ORIGIN: origin,
  };
  const child = spawn(process.execPath, ["src/server.js"], {
    env,
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
  const login = async (role, personId) => {
    const r = await req("/api/select-login", "POST", {
      role,
      personId,
      password: "test-management-password",
    });
    assert.equal(r.status, 200);
    cookie = r.headers.get("set-cookie").split(";")[0];
  };
  const file = readFileSync("tests/fixtures/roster-update.xlsx");
  const upload = (query = "") =>
    fetch(origin + "/api/admin/import" + query, {
      method: "POST",
      headers: { origin, "content-type": "application/octet-stream", cookie },
      body: file,
    });
  try {
    await login("office", "smirnova");
    assert.equal((await upload()).status, 403);
    await login("admin", "gadzhieva");
    // Zip-бомба: лист «База» распаковывается больше чем в 50 МБ.
    const bomb = await fetch(origin + "/api/admin/import", {
      method: "POST",
      headers: { origin, "content-type": "application/octet-stream", cookie },
      body: workbook({ База: 60 }),
    });
    assert.equal(bomb.status, 400);
    assert.match((await bomb.json()).error, /50 МБ/);
    assert.equal((await fetch(origin + "/healthz")).status, 200);
    // Ручная связь должна пережить обновление.
    assert.equal(
      (
        await req("/api/admin/enrollments", "POST", {
          studentId: "s_test_1",
          teacherId: "t_test_2",
          course: "Ручная дисциплина",
        })
      ).status,
      200,
    );
    const preview = await (await upload()).json();
    assert.equal(preview.preview, true);
    assert.deepEqual(preview.students.added, ["Студент Новый"]);
    assert.deepEqual(preview.students.missing, ["Студент Второй"]);
    assert.deepEqual(preview.teachers.added, ["Преподаватель Новый"]);
    assert.equal(preview.enrollments.added, 4); // Экономика Г-1 и Г-3, Философия Г-4, История Г-5
    assert.equal(preview.enrollments.removed, 1); // Логика
    assert.equal(preview.quality.unresolved, 1);
    // План ничего не записал.
    assert.equal((await (await req("/api/admin/teachers")).json()).length, 2);
    const groupsOf = async (id) =>
      (await (await req("/api/admin/overview")).json()).students.find(
        (s) => s.id === id,
      ).groups;
    assert.deepEqual(await groupsOf("s_test_1"), ["Г-1", ""]);
    const applied = await (await upload("?apply=1")).json();
    assert.equal(applied.preview, false);
    assert.equal(applied.enrollments.added, 4);
    const teachers = await (await req("/api/admin/teachers")).json();
    // Связи из импорта сразу видны в списке преподавателей и в обзоре.
    assert.deepEqual(
      teachers.map(({ name, courses, students }) => [name, courses, students]),
      [
        ["Преподаватель Второй", ["История", "Ручная дисциплина"], 3],
        ["Преподаватель Новый", ["Философия"], 1],
        ["Преподаватель Первый", ["Право", "Экономика"], 2],
      ],
    );
    assert.deepEqual(await groupsOf("s_test_1"), ["Г-1", "", "Г-3"]);
    assert.ok(teachers.some((t) => t.name === "Преподаватель Новый"));
    assert.ok(!teachers.some((t) => t.name.startsWith("Вак_")));
    assert.equal(teachers.length, 3); // «Вак_Преподаватель» сопоставлен с Преподавателем Вторым по дисциплине
    assert.ok(
      (
        await (
          await req(
            "/api/admin/students/" +
              (await (await req("/api/admin/overview")).json()).students.find(
                (x) => x.name === "Студент Новый",
              ).id,
          )
        ).json()
      ).links.some(
        (l) =>
          l.teacherId === "t_test_2" &&
          l.course === "История" &&
          l.group === "Г-5",
      ),
    );
    const card = await (await req("/api/admin/students/s_test_1")).json();
    assert.deepEqual(
      card.links.map((l) => l.course + "/" + l.group).sort(),
      [
        "Право/Г-1",
        "Ручная дисциплина/",
        "Экономика/Г-1",
        "Экономика/Г-3",
      ].sort(),
    );
    const untouched = await (await req("/api/admin/students/s_test_2")).json();
    assert.equal(untouched.links.length, 2);
    // Повторное применение того же файла ничего не меняет.
    const again = await (await upload("?apply=1")).json();
    assert.deepEqual(
      [
        again.students.added.length,
        again.teachers.added.length,
        again.enrollments.added,
        again.enrollments.removed,
      ],
      [0, 0, 0, 0],
    );
    const overview = await (await req("/api/admin/overview")).json();
    assert.equal(overview.audit[0].action, "roster.import");
    assert.match(overview.audit[1].label, /связей \+4 −1/);
    assert.equal(overview.quality.sourceRows, 4);

    // Преподаватели без отметок: у всех lastMark пуст, после отметки – дата.
    await login("teacher", "t_test_1");
    const daily = await (
      await req("/api/daily?course=" + encodeURIComponent("Право"))
    ).json();
    assert.equal(
      (
        await req("/api/daily", "PUT", {
          date: daily.date,
          course: "Право",
          version: daily.version,
          marks: daily.students.map((s) => ({
            studentId: s.id,
            status: "present",
          })),
        })
      ).status,
      200,
    );
    await login("admin", "gadzhieva");
    const marked = await (await req("/api/admin/teachers")).json();
    assert.equal(
      marked.find((t) => t.id === "t_test_1").lastMark,
      moscowDate(),
    );
    assert.equal(marked.find((t) => t.id === "t_test_2").lastMark, null);
    assert.equal(
      (await (await req("/api/admin/overview")).json()).faculty.silentTeachers,
      2,
    );

    // Перевод на следующий курс: обучающиеся +1, выпускник не трогается.
    assert.equal(
      (
        await req("/api/admin/students/s_test_1/profile", "PUT", {
          program: "Юриспруденция",
          year: 2,
          foreignStatus: "confirmed",
          version: 0,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await req("/api/admin/students/s_test_2/profile", "PUT", {
          program: "Право",
          year: 5,
          foreignStatus: "confirmed",
          enrollmentStatus: "graduated",
          version: 0,
        })
      ).status,
      200,
    );
    await login("office", "smirnova");
    assert.equal((await req("/api/admin/year-rollover", "POST")).status, 403);
    await login("admin", "gadzhieva");
    const rolled = await (await req("/api/admin/year-rollover", "POST")).json();
    assert.equal(rolled.count, 1);
    assert.equal(
      (await (await req("/api/admin/students/s_test_1")).json()).student.year,
      3,
    );
    assert.equal(
      (await (await req("/api/admin/students/s_test_2")).json()).student.year,
      5,
    );
    const after = await (await req("/api/admin/overview")).json();
    assert.equal(after.audit[0].action, "year.rollover");
    assert.equal(after.yearRollover.count, 1);
  } finally {
    child.kill("SIGTERM");
    await new Promise((r) => child.once("exit", r));
    rmSync(tmp, { recursive: true, force: true });
  }
});
