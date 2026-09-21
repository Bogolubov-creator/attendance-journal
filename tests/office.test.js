import { passwordHash } from "../src/management-auth.js";
import test from "node:test";
import assert from "node:assert/strict";
import {
  managerFor,
  canEditStudent,
  procedureStatus,
  validDate,
} from "../src/office.js";
import { spawn } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
test("Распределение по программе и курсу, без угадывания неизвестного", () => {
  assert.equal(
    managerFor({ program: "Юриспруденция", year: 2 }).id,
    "smirnova",
  );
  assert.equal(managerFor({ program: "Юриспруденция", year: 4 }), null);
  assert.equal(managerFor({ program: "Право", year: 4 }).id, "bakhareva");
  assert.equal(managerFor({ program: "ЛигалТех", year: 1 }).id, "polyanskaya");
  assert.equal(managerFor({ program: "ЛигалТех" }), null);
  assert.equal(
    canEditStudent(
      { role: "office", id: "motorov" },
      { program: "Юриспруденция", year: 2 },
    ),
    false,
  );
});
test("Неизвестное и документы на проверке не превращаются в просрочку", () => {
  const today = "2026-09-16";
  assert.equal(procedureStatus(null, today), "unknown");
  assert.equal(
    procedureStatus({ state: "submitted", dueDate: "2026-01-01" }, today),
    "submitted",
  );
  assert.equal(
    procedureStatus({ state: "exempt", dueDate: "2026-01-01" }, today),
    "exempt",
  );
  assert.equal(
    procedureStatus({ state: "pending", dueDate: "" }, today),
    "pending",
  );
  assert.equal(
    procedureStatus({ state: "pending", dueDate: today }, today),
    "pending",
  );
  assert.equal(
    procedureStatus({ state: "pending", dueDate: "2026-09-15" }, today),
    "overdue",
  );
  assert.equal(
    procedureStatus({ state: "confirmed", validUntil: "2026-09-15" }, today),
    "expired",
  );
  assert.equal(validDate("2026-02-30"), false);
  assert.equal(validDate("2028-02-29"), true);
});
test("Выбор сотрудника, зоны редактирования и отдельный учёт процедур", async () => {
  const tmp = mkdtempSync("work/office-test-"),
    origin = "http://127.0.0.1:3103";
  const child = spawn(process.execPath, ["src/server.js"], {
    env: {
      ...process.env,
      MANAGEMENT_PASSWORD_HASH: passwordHash("test-management-password"),
      DEMO_MODE: "true",
      AUTH_MODE: "selection",
      AUTO_BACKUP: "false",
      DB_PATH: join(tmp, "db.sqlite"),
      PORT: "3103",
      APP_ORIGIN: origin,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let cookie = "";
  const versions = new Map();
  const req = async (route, method = "GET", body) => {
    const versioned =
      method === "PUT" && /\/(profile|procedures\/[^/]+)$/.test(route);
    if (versioned && body.version === undefined)
      body = { ...body, version: versions.get(route) || 0 };
    const response = await fetch(origin + route, {
      method,
      headers: { origin, "content-type": "application/json", cookie },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (versioned && response.ok)
      versions.set(route, (await response.clone().json()).version);
    return response;
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
    await new Promise((resolve, reject) => {
      child.stdout.once("data", resolve);
      child.once("error", reject);
      child.once("exit", (c) => reject(Error("exit " + c)));
    });
    const sid = JSON.parse(readFileSync("data/roster.json")).students[0].id;
    assert.equal(
      (
        await req("/api/select-login", "POST", {
          role: "admin",
          personId: "smirnova",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await req("/api/select-login", "POST", {
          role: "admin",
          personId: "bakhareva",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await req("/api/select-login", "POST", {
          role: "office",
          personId: "smirnova",
          password: "wrong",
        })
      ).status,
      403,
    );
    assert.equal(
      (await req("/api/demo-login", "POST", { role: "admin" })).status,
      403,
    );
    await login("admin", "bakhareva");
    assert.equal(
      (
        await req("/api/admin/students/" + sid + "/profile", "PUT", {
          program: "Юриспруденция",
          year: 2,
          foreignStatus: "confirmed",
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await req("/api/admin/students/" + sid + "/profile", "PUT", {
          program: "Юриспруденция",
          year: 3,
          foreignStatus: "confirmed",
          version: 0,
        })
      ).status,
      409,
    );
    await login("office", "motorov");
    assert.equal(
      (
        await req("/api/admin/students/" + sid + "/procedures/visa", "PUT", {
          state: "pending",
          dueDate: "2020-01-01",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await req("/api/admin/students/" + sid + "/profile", "PUT", {
          program: "Юриспруденция",
          year: 3,
          foreignStatus: "confirmed",
        })
      ).status,
      403,
    );
    await login("office", "smirnova");
    assert.equal(
      (
        await req("/api/admin/students/" + sid + "/procedures/visa", "PUT", {
          state: "pending",
          dueDate: "2020-01-01",
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await req("/api/admin/students/" + sid + "/procedures/visa", "PUT", {
          state: "pending",
          dueDate: "2099-01-01",
          version: 0,
        })
      ).status,
      409,
    );
    let data = await (await req("/api/admin/overview")).json();
    assert.equal(data.faculty.confirmed, 1);
    assert.equal(data.students.find((s) => s.id === sid).procedureOverdue, 1);
    assert.equal(data.students.find((s) => s.id === sid).absenceAlert, false);
    assert.equal(
      (
        await req("/api/admin/students/" + sid + "/procedures/visa", "PUT", {
          state: "confirmed",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await req("/api/admin/students/" + sid + "/procedures/visa", "PUT", {
          state: "confirmed",
          completedAt: "2020-02-01",
          validUntil: "2020-01-01",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await req("/api/admin/students/" + sid + "/procedures/visa", "PUT", {
          state: "exempt",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await req("/api/admin/students/" + sid + "/procedures/visa", "PUT", {
          state: "submitted",
          dueDate: "2020-01-01",
        })
      ).status,
      200,
    );
    data = await (await req("/api/admin/students/" + sid)).json();
    assert.equal(data.student.procedureOverdue, 0);
    assert.equal(data.student.procedureReview, 1);
    assert.equal(
      data.procedures.find((p) => p.id === "visa").checkedBy,
      "Смирнова Екатерина Дмитриевна",
    );
    const tid = JSON.parse(readFileSync("data/roster.json")).teachers[0].id;
    await login("admin", "bakhareva");
    assert.equal(
      (
        await req("/api/admin/students/" + sid + "/profile", "PUT", {
          program: "Юриспруденция",
          year: 2,
          foreignStatus: "excluded",
        })
      ).status,
      200,
    );
    const roster = JSON.parse(readFileSync("data/roster.json"));
    const enrollment = roster.enrollments.find((e) => e.studentId === sid);
    // Исключённый из контингента студент пропадает из журнала преподавателя.
    await login("teacher", enrollment.teacherId);
    const journal = await (
      await req("/api/daily?course=" + encodeURIComponent(enrollment.course))
    ).json();
    assert.equal(
      journal.students.some((s) => s.id === sid),
      false,
    );
    await login("teacher", tid);
    assert.equal((await req("/api/admin/students/" + sid)).status, 403);
    for (let attempt = 0; attempt < 5; attempt++)
      assert.equal(
        (
          await req("/api/select-login", "POST", {
            role: "admin",
            personId: "bakhareva",
            password: "wrong",
          })
        ).status,
        403,
      );
    assert.equal(
      (
        await req("/api/select-login", "POST", {
          role: "admin",
          personId: "bakhareva",
          password: "test-management-password",
        })
      ).status,
      429,
    );
  } finally {
    child.kill("SIGTERM");
    await new Promise((r) => child.once("exit", r));
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("Пароль руководства хранится как хеш и проверяется точно", async () => {
  const { verifyPassword } = await import("../src/management-auth.js");
  const encoded = passwordHash("Valid test password");
  assert.ok(verifyPassword("Valid test password", encoded));
  assert.equal(verifyPassword("wrong", encoded), false);
  assert.equal(verifyPassword(undefined, encoded), false);
  assert.equal(verifyPassword("Valid test password", ""), false);
});
