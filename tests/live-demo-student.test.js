import { passwordHash } from "../src/management-auth.js";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const origin = "http://127.0.0.1:3145";
const temp = mkdtempSync(join(tmpdir(), "attendance-live-demo-"));
const call = (path, body) =>
  fetch(origin + path, {
    method: body ? "POST" : "GET",
    headers: { origin, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

test("Живые данные в демо-режиме: нет списка студентов и демо-входа студентом", async (t) => {
  const child = spawn(process.execPath, ["src/server.js"], {
    env: {
      ...process.env,
      ROSTER_PATH: "tests/fixtures/roster.json",
      MANAGEMENT_PASSWORD_HASH: passwordHash("test-management-password"),
      DEMO_MODE: "true",
      DATA_MODE: "live",
      AUTO_BACKUP: "false",
      DB_PATH: join(temp, "db.sqlite"),
      PORT: "3145",
      APP_ORIGIN: origin,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    child.stdout.once("data", resolve);
    child.once("exit", (c) => reject(Error("server exit " + c)));
  });
  try {
    await t.test("Анонимная сессия не отдаёт ФИО студентов", async () => {
      const session = await (await call("/api/session")).json();
      assert.deepEqual(session.demoStudents, []);
    });
    await t.test("Демо-вход студентом отклоняется", async () => {
      const r = await call("/api/demo-login", {
        role: "student",
        studentId: "s_test_1",
        password: "test-management-password",
      });
      assert.equal(r.status, 403);
      assert.equal(r.headers.get("set-cookie"), null);
    });
  } finally {
    child.kill();
    rmSync(temp, { recursive: true, force: true });
  }
});
