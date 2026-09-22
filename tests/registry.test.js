import { passwordHash } from "../src/management-auth.js";
import { moscowDate } from "../src/domain.js";
import test from "node:test";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
test("Реестр в базе: файл нужен только для первого наполнения, правки через сайт сохраняются", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "attendance-registry-")),
    origin = "http://127.0.0.1:3106",
    rosterPath = join(tmp, "roster.json");
  writeFileSync(
    rosterPath,
    JSON.stringify({
      students: [
        { id: "s_1", name: "Студент Первый" },
        { id: "s_2", name: "Студент Второй" },
      ],
      teachers: [
        { id: "t_1", name: "Преподаватель Первый" },
        { id: "t_2", name: "Преподаватель Второй" },
      ],
      enrollments: [
        {
          studentId: "s_1",
          teacherId: "t_1",
          group: "Г-1",
          course: "Право",
          kind: "Лекция",
        },
      ],
      quality: {},
    }),
  );
  const env = {
    ...process.env,
    MANAGEMENT_PASSWORD_HASH: passwordHash("test-management-password"),
    DEMO_MODE: "true",
    AUTH_MODE: "selection",
    AUTO_BACKUP: "false",
    DB_PATH: join(tmp, "db.sqlite"),
    ROSTER_PATH: rosterPath,
    PORT: "3106",
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
    if (child.exitCode !== null) return;
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
  const daily = async (course) =>
    (await req("/api/daily?course=" + encodeURIComponent(course))).json();
  try {
    await start();
    await stop();
    // После первого запуска файл реестра больше не нужен.
    rmSync(rosterPath);
    await start();
    // Менеджер добавляет преподавателей, но не переименовывает и не удаляет их.
    await login("office", "smirnova");
    const added = await req("/api/admin/teachers", "POST", {
      name: "Преподаватель Менеджера",
    });
    assert.equal(added.status, 200);
    const addedId = (await added.json()).id;
    assert.equal(
      (
        await req("/api/admin/teachers/" + addedId, "PUT", {
          name: "Переименованный Преподаватель",
        })
      ).status,
      403,
    );
    assert.equal(
      (await req("/api/admin/teachers/" + addedId, "DELETE")).status,
      403,
    );
    await login("admin", "gadzhieva");
    assert.equal(
      (await (await req("/api/admin/overview")).json()).students.length,
      2,
    );

    // Преподаватели: добавить, переименовать, дубль ФИО отклоняется.
    assert.equal(
      (await req("/api/admin/teachers", "POST", { name: " " })).status,
      400,
    );
    const created = await req("/api/admin/teachers", "POST", {
      name: "Новый  Преподаватель",
    });
    assert.equal(created.status, 200);
    const { id: tid } = await created.json();
    assert.equal(
      (
        await req("/api/admin/teachers", "POST", {
          name: "новый преподаватель",
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await req("/api/admin/teachers/" + tid, "PUT", {
          name: "Преподаватель Второй",
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await req("/api/admin/teachers/" + tid, "PUT", {
          name: "Преподаватель Третий",
        })
      ).status,
      200,
    );

    // Связи: студент появляется в журнале преподавателя и исчезает из него.
    const link = {
      studentId: "s_2",
      teacherId: tid,
      course: "Новая дисциплина",
    };
    assert.equal(
      (
        await req("/api/admin/enrollments", "POST", {
          ...link,
          studentId: "нет",
        })
      ).status,
      400,
    );
    assert.equal(
      (await req("/api/admin/enrollments", "POST", link)).status,
      200,
    );
    assert.equal(
      (await req("/api/admin/enrollments", "POST", link)).status,
      409,
    );
    assert.deepEqual(
      (await (await req("/api/admin/students/s_2")).json()).links,
      [
        {
          teacherId: tid,
          teacher: "Преподаватель Третий",
          course: link.course,
        },
      ],
    );
    assert.equal(
      (await req("/api/admin/teachers/" + tid, "DELETE")).status,
      409,
    );
    await login("teacher", tid);
    assert.deepEqual(
      (await daily("Новая дисциплина")).students.map((s) => s.id),
      ["s_2"],
    );
    await login("admin", "gadzhieva");
    assert.equal(
      (await req("/api/admin/enrollments", "DELETE", link)).status,
      200,
    );
    assert.equal(
      (await req("/api/admin/enrollments", "DELETE", link)).status,
      404,
    );
    assert.equal(
      (await req("/api/admin/teachers/" + tid, "DELETE")).status,
      200,
    );

    // Карточка хранит сведения из списков международного офиса.
    const details = {
      program: "",
      year: 0,
      foreignStatus: "confirmed",
      version: 0,
      nameLatin: "STUDENT PERVYI",
      sendingCountry: "Казахстан",
      programVersion: "Б 40.03.01 Ю М 2024 очная Юриспруденция",
      curator: "Домбаев",
      housing: "dormitory",
      inRussia: "yes",
      passportUntil: "2032-01-10",
      migrationCardUntil: "2026-06-30",
    };
    assert.equal(
      (
        await req("/api/admin/students/s_1/profile", "PUT", {
          ...details,
          housing: "палатка",
        })
      ).status,
      400,
    );
    assert.equal(
      (await req("/api/admin/students/s_1/profile", "PUT", details)).status,
      200,
    );
    const saved = (await (await req("/api/admin/students/s_1")).json()).student;
    for (const key of Object.keys(details))
      if (key !== "version") assert.equal(saved[key], details[key], key);

    // Студенты: переименование; удаление запрещено, если есть отметки.
    assert.equal(
      (await req("/api/admin/students/s_2", "PUT", { name: "Студент Первый" }))
        .status,
      409,
    );
    assert.equal(
      (await req("/api/admin/students/s_2", "PUT", { name: "Студент Иной" }))
        .status,
      200,
    );
    // Показатели студента считаются по дневным отметкам преподавателей.
    await login("teacher", "t_1");
    for (let back = 1; back <= 8; back++)
      assert.equal(
        (
          await req("/api/daily", "PUT", {
            date: moscowDate(new Date(Date.now() - back * 86400000)),
            course: "Право",
            version: 0,
            marks: [{ studentId: "s_1", status: "absent" }],
          })
        ).status,
        200,
      );
    await login("admin", "gadzhieva");
    const alerted = (
      await (await req("/api/admin/overview")).json()
    ).students.find((x) => x.id === "s_1");
    assert.equal(alerted.days, 8);
    assert.equal(alerted.absenceAlert, true);
    const dashboard = await (await req("/api/daily/overview")).json();
    const warning = dashboard.students.find((s) => s.id === "s_1");
    assert.equal(warning.absenceAlert, true);
    assert.equal(warning.absenceDays, 8);
    await login("teacher", "t_1");
    assert.equal(
      (
        await req("/api/daily", "PUT", {
          date: moscowDate(),
          course: "Право",
          version: 0,
          marks: [{ studentId: "s_1", status: "present" }],
        })
      ).status,
      200,
    );
    await login("admin", "gadzhieva");
    assert.equal((await req("/api/admin/students/s_1", "DELETE")).status, 409);
    assert.equal((await req("/api/admin/students/s_2", "DELETE")).status, 200);

    await stop();
    await start();
    await login("admin", "gadzhieva");
    const overview = await (await req("/api/admin/overview")).json();
    assert.deepEqual(
      overview.students.map((s) => s.id),
      ["s_1"],
    );
    assert.equal(overview.students[0].lastVisit, moscowDate());
    assert.equal(overview.students[0].absenceAlert, false);
    const afterVisit = await (await req("/api/daily/overview")).json();
    assert.equal(afterVisit.students[0].absenceAlert, false);
    assert.equal(afterVisit.students[0].absenceDays, 0);
    assert.equal(overview.students[0].marked, 9);
    const card = await (await req("/api/admin/students/s_1")).json();
    assert.deepEqual(card.records[0], {
      date: moscowDate(),
      course: "Право",
      teacher: "Преподаватель Первый",
      status: "present",
    });
    assert.equal(card.records.length, 9);
    assert.deepEqual(
      (await (await req("/api/admin/teachers")).json()).map((t) => t.name),
      [
        "Преподаватель Второй",
        "Преподаватель Менеджера",
        "Преподаватель Первый",
      ],
    );
  } finally {
    await stop();
    rmSync(tmp, { recursive: true, force: true });
  }
});
test("Пустой реестр: сервер запускается без файла, реестр создаётся через сайт", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "attendance-registry-empty-")),
    origin = "http://127.0.0.1:3107";
  const child = spawn(process.execPath, ["src/server.js"], {
    env: {
      ...process.env,
      MANAGEMENT_PASSWORD_HASH: passwordHash("test-management-password"),
      DEMO_MODE: "true",
      AUTH_MODE: "selection",
      AUTO_BACKUP: "false",
      DB_PATH: join(tmp, "db.sqlite"),
      ROSTER_PATH: join(tmp, "missing.json"),
      PORT: "3107",
      APP_ORIGIN: origin,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await new Promise((resolve, reject) => {
      child.stdout.once("data", resolve);
      child.once("exit", (c) => reject(Error("exit " + c)));
    });
    const session = await (await fetch(origin + "/api/session")).json();
    assert.deepEqual(session.teachers, []);
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((r) => child.once("exit", r));
    }
    rmSync(tmp, { recursive: true, force: true });
  }
});
