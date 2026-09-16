import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { DatabaseSync } from "node:sqlite";
import { registerDaily, summarizeAttendance } from "../src/daily.js";

test("Период: присутствие побеждает отсутствие, нет ответа не означает отсутствие", () => {
  const rows = summarizeAttendance(
    [{ id: "a" }, { id: "b" }, { id: "c" }],
    [
      { studentId: "a", date: "2026-09-01", status: "absent" },
      { studentId: "a", date: "2026-09-01", status: "present" },
      { studentId: "a", date: "2026-09-01", status: "present" },
      { studentId: "b", date: "2026-09-02", status: "absent" },
      { studentId: "c", date: "2026-08-01", status: "present" },
    ],
    "2026-09-01",
    "2026-09-07",
  );
  assert.deepEqual(
    rows.map((s) => s.status),
    ["present", "absent", "unknown"],
  );
  assert.equal(rows[0].daysPresent, 1);
  assert.equal(rows[0].history.length, 3);
  assert.equal(rows[2].lastVisit, "2026-08-01");
});
test("Дневной журнал: изоляция, конфликты, сохранение, сводка и экспорт", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE marks(studentId TEXT,status TEXT,lessonId TEXT); CREATE TABLE lessons(id TEXT,teacherId TEXT,data TEXT)",
  );
  const roster = {
    teachers: [
      { id: "t1", name: "Первый" },
      { id: "t2", name: "Второй" },
    ],
    students: [
      { id: "a", name: "Анна" },
      { id: "b", name: "Борис" },
      { id: "c", name: "Вера" },
    ],
    enrollments: [
      { teacherId: "t1", studentId: "a" },
      { teacherId: "t2", studentId: "a" },
      { teacherId: "t2", studentId: "b" },
    ],
  };
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    if (req.headers["x-user"])
      req.session = {
        user: {
          id: req.headers["x-user"],
          role: req.headers["x-role"] || "teacher",
        },
      };
    next();
  });
  const auth = (req, res, next) => (req.session ? next() : res.sendStatus(401)),
    admin = (req, res, next) =>
      req.session.user.role === "admin" ? next() : res.sendStatus(403);
  registerDaily(app, {
    db,
    roster,
    auth,
    admin,
    studentProfile: (id) => roster.students.find((s) => s.id === id),
    audit: () => {},
  });
  app.use((e, req, res, next) =>
    res.status(e.status || 500).json({ error: e.message }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const url = "http://127.0.0.1:" + server.address().port;
  const request = (path, user = "t1", body, role = "teacher") =>
    fetch(url + path, {
      method: body ? "PUT" : "GET",
      headers: {
        ...(user ? { "x-user": user, "x-role": role } : {}),
        "content-type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  try {
    assert.equal((await request("/api/daily", null)).status, 401);
    const first = await (await request("/api/daily?date=2026-09-01")).json();
    assert.deepEqual(
      first.students.map((s) => s.id),
      ["a"],
    );
    const write = {
      date: "2026-09-01",
      version: 0,
      marks: [{ studentId: "a", status: "present" }],
    };
    assert.equal(
      (
        await request("/api/daily", "t1", {
          ...write,
          marks: [{ studentId: "b", status: "absent" }],
        })
      ).status,
      400,
    );
    assert.equal(
      (await request("/api/daily", "t1", { ...write, date: "" })).status,
      400,
    );
    assert.equal(
      (await request("/api/daily", "t1", { ...write, date: "2099-01-01" }))
        .status,
      400,
    );
    assert.equal((await request("/api/daily", "t1", write)).status, 200);
    assert.equal((await request("/api/daily", "t1", write)).status, 409);
    assert.equal(
      (
        await request("/api/daily", "t2", {
          ...write,
          marks: [
            { studentId: "a", status: "absent" },
            { studentId: "b", status: "absent" },
          ],
        })
      ).status,
      200,
    );
    const saved = await (await request("/api/daily?date=2026-09-01")).json();
    assert.equal(saved.version, 1);
    assert.equal(saved.marks[0].status, "present");
    const route = "/api/daily/overview?from=2026-09-01&to=2026-09-07";
    assert.equal((await request(route)).status, 403);
    const overview = await (await request(route, "boss", null, "admin")).json();
    assert.deepEqual(
      overview.students.map((s) => s.status),
      ["present", "absent", "unknown"],
    );
    const csv = await (
      await request(
        "/api/daily/export?from=2026-09-01&to=2026-09-07",
        "boss",
        null,
        "admin",
      )
    ).text();
    assert.match(csv, /Анна/);
    assert.match(csv, /Был хотя бы раз/);
    assert.equal(
      (
        await request("/api/daily", "t1", {
          ...write,
          version: 1,
          marks: [{ studentId: "a", status: null }],
        })
      ).status,
      200,
    );
    assert.equal(
      (await (await request("/api/daily?date=2026-09-01")).json()).marks.length,
      0,
    );
  } finally {
    server.close();
    db.close();
  }
});
