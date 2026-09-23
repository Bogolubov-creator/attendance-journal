import { passwordHash } from "../src/management-auth.js";
import test from "node:test";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
test("Добавление иностранного студента: только руководство, привязка к преподавателю, сохранность после перезапуска", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "attendance-add-student-")),
    origin = "http://127.0.0.1:3105",
    roster = JSON.parse(readFileSync("tests/fixtures/roster.json"));
  const env = {
    ...process.env,
    ROSTER_PATH: "tests/fixtures/roster.json",
    MANAGEMENT_PASSWORD_HASH: passwordHash("test-management-password"),
    DEMO_MODE: "true",
    AUTH_MODE: "selection",
    AUTO_BACKUP: "false",
    DB_PATH: join(tmp, "db.sqlite"),
    PORT: "3105",
    APP_ORIGIN: origin,
  };
  let child,
    cookie = "";
  const start = async () => {
    child = spawn(process.execPath, ["src/server.js"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise((resolve, reject) => {
      child.stdout.once("data", resolve);
      child.once("error", reject);
      child.once("exit", (c) => reject(Error("exit " + c)));
    });
  };
  const stop = async () => {
    child.kill("SIGTERM");
    await new Promise((r) => child.once("exit", r));
  };
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
  const teacher = roster.teachers[0];
  const student = {
    name: "Тестовый Студент Добавленный",
    program: "Юриспруденция",
    year: 1,
    foreignStatus: "confirmed",
    citizenship: "Казахстан",
    links: [{ teacherId: teacher.id, course: "Тестовая дисциплина" }],
  };
  try {
    await start();
    // Менеджер (Смирнова – Юриспруденция, 2 курс) заводит студентов только своих программ и курсов.
    await login("office", "smirnova");
    assert.equal(
      (await req("/api/admin/students", "POST", student)).status,
      403,
    );
    const own = { ...student, name: "Тестовый Студент Менеджера", year: 2 };
    const ownCreated = await req("/api/admin/students", "POST", own);
    assert.equal(ownCreated.status, 200);
    const ownId = (await ownCreated.json()).id;
    assert.equal(
      (
        await req("/api/admin/students/" + ownId, "PUT", {
          name: "Тестовый Студент Переименованный",
        })
      ).status,
      200,
    );
    const ownLink = {
      studentId: ownId,
      teacherId: teacher.id,
      course: "Вторая дисциплина",
    };
    assert.equal(
      (await req("/api/admin/enrollments", "POST", ownLink)).status,
      200,
    );
    assert.equal(
      (
        await req("/api/admin/teachers", "POST", {
          name: "Преподаватель От Менеджера",
        })
      ).status,
      200,
    );
    // Чужой курс (Моторов – 3 курс) менять нельзя.
    await login("office", "motorov");
    assert.equal(
      (
        await req("/api/admin/students/" + ownId, "PUT", {
          name: "Чужая Правка",
        })
      ).status,
      403,
    );
    assert.equal(
      (await req("/api/admin/enrollments", "DELETE", ownLink)).status,
      403,
    );
    assert.equal(
      (await req("/api/admin/students/" + ownId, "DELETE")).status,
      403,
    );
    await login("office", "smirnova");
    assert.equal(
      (await req("/api/admin/students/" + ownId, "DELETE")).status,
      200,
    );
    // Полный доступ видит правки менеджеров в «Последних изменениях».
    await login("admin", "gadzhieva");
    const changes = (await (await req("/api/admin/overview")).json()).audit;
    assert.deepEqual(
      changes.slice(0, 5).map((c) => c.action),
      [
        "student.delete",
        "teacher.add",
        "enrollment.add",
        "student.rename",
        "student.add",
      ],
    );
    assert.equal(changes[0].role, "office");
    assert.equal(changes[0].actor, "Смирнова Екатерина Дмитриевна");
    assert.equal(changes[0].label, "Тестовый Студент Переименованный");
    assert.equal(changes[1].label, "Преподаватель От Менеджера");
    for (const bad of [
      { ...student, name: "" },
      { ...student, links: [] },
      { ...student, links: [{ teacherId: "нет", course: "X" }] },
      { ...student, program: "Несуществующая" },
    ])
      assert.equal((await req("/api/admin/students", "POST", bad)).status, 400);
    const created = await req("/api/admin/students", "POST", student);
    assert.equal(created.status, 200);
    const { id } = await created.json();
    assert.equal(
      (await req("/api/admin/students", "POST", student)).status,
      409,
    );
    // Идентификатор по прежней формуле: существующие id не меняются.
    assert.equal(
      id,
      "s_" +
        createHash("sha256").update(student.name).digest("hex").slice(0, 16),
    );
    // ФИО при добавлении проверяется тем же путём, что при правке реестра.
    for (const name of [
      "Аб",
      "Я".repeat(151),
      roster.students[0].name.toLocaleUpperCase("ru"),
    ]) {
      const added = await req("/api/admin/students", "POST", {
        ...student,
        name,
      });
      const renamed = await req("/api/admin/students/" + id, "PUT", { name });
      assert.equal(added.status, renamed.status, name.slice(0, 20));
      assert.deepEqual(await added.json(), await renamed.json());
    }
    const card = await (await req("/api/admin/students/" + id)).json();
    assert.equal(card.student.program, "Юриспруденция");
    assert.equal(card.student.citizenship, "Казахстан");
    assert.equal(card.student.manager?.id, "akhmyatzhanov");
    assert.deepEqual(card.courses, ["Тестовая дисциплина"]);
    const teachers = await (await req("/api/admin/teachers")).json();
    assert.ok(
      teachers
        .find((t) => t.id === teacher.id)
        .courses.includes("Тестовая дисциплина"),
    );
    await login("teacher", teacher.id);
    const daily = await (
      await req(
        "/api/daily?course=" + encodeURIComponent("Тестовая дисциплина"),
      )
    ).json();
    assert.ok(daily.students.some((s) => s.id === id));
    await stop();
    await start();
    await login("admin", "gadzhieva");
    assert.equal((await req("/api/admin/students/" + id)).status, 200);
    const overview = await (await req("/api/admin/overview")).json();
    assert.ok(overview.students.some((s) => s.id === id));
  } finally {
    await stop();
    rmSync(tmp, { recursive: true, force: true });
  }
});
