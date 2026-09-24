import { passwordHash } from "../src/management-auth.js";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const origin = "http://127.0.0.1:3144";
const call = (path, options = {}) =>
  fetch(origin + path, {
    method: options.method || "GET",
    headers: {
      origin,
      "content-type": "application/json",
      ...(options.cookie ? { cookie: options.cookie } : {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });

async function start(dbPath, password) {
  const child = spawn(process.execPath, ["src/server.js"], {
    env: {
      ...process.env,
      ROSTER_PATH: "tests/fixtures/roster.json",
      MANAGEMENT_PASSWORD_HASH: passwordHash(password),
      DEMO_MODE: "true",
      AUTO_BACKUP: "false",
      DB_PATH: dbPath,
      PORT: "3144",
      APP_ORIGIN: origin,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    child.stdout.once("data", resolve);
    child.once("exit", (c) => reject(Error("server exit " + c)));
  });
  return child;
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((r) => child.once("exit", r));
}
async function cookieFrom(path, body) {
  const r = await call(path, {
    method: "POST",
    body: { ...body, password: "old-password" },
  });
  assert.equal(r.status, 200, await r.clone().text());
  return r.headers.get("set-cookie").split(";")[0];
}

test("Смена пароля закрывает сессии всех ролей, выданные по паролю", async () => {
  const temp = mkdtempSync(join(tmpdir(), "attendance-revoke-"));
  const dbPath = join(temp, "db.sqlite");
  let child = await start(dbPath, "old-password");
  try {
    const overview = "/api/admin/overview?from=2026-09-01&to=2026-09-23";
    const sessions = {
      "преподаватель (выбор)": [
        await cookieFrom("/api/select-login", {
          role: "teacher",
          personId: "t_test_1",
        }),
        "/api/daily",
      ],
      "преподаватель (демо)": [
        await cookieFrom("/api/demo-login", {
          role: "teacher",
          teacherId: "t_test_1",
        }),
        "/api/daily",
      ],
      "демо-студент": [
        await cookieFrom("/api/demo-login", {
          role: "student",
          studentId: "s_test_1",
        }),
        "/api/student/profile",
      ],
      менеджер: [
        await cookieFrom("/api/select-login", {
          role: "office",
          personId: "smirnova",
        }),
        overview,
      ],
      "полный доступ (выбор)": [
        await cookieFrom("/api/select-login", {
          role: "admin",
          personId: "gadzhieva",
        }),
        overview,
      ],
      "полный доступ (демо)": [
        await cookieFrom("/api/demo-login", { role: "admin" }),
        overview,
      ],
    };
    for (const [who, [cookie, path]] of Object.entries(sessions))
      assert.equal((await call(path, { cookie })).status, 200, who);
    await stop(child);

    // Сессия университетского входа – так её пишет OIDC-колбэк.
    const oidcToken = "oidc-session-token";
    const db = new DatabaseSync(dbPath);
    db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(
      createHash("sha256").update(oidcToken).digest("hex"),
      JSON.stringify({
        user: {
          id: "t_test_1",
          name: "Преподаватель Первый",
          email: "teacher@hse.ru",
          role: "teacher",
          source: "explicit",
          subject: "oidc-subject",
        },
      }),
      Date.now() + 3600000,
    );
    db.close();

    child = await start(dbPath, "new-password");
    for (const [who, [cookie, path]] of Object.entries(sessions))
      assert.equal((await call(path, { cookie })).status, 401, who);
    assert.equal(
      (await call("/api/daily", { cookie: "journal=" + oidcToken })).status,
      200,
      "сессия OIDC",
    );
  } finally {
    await stop(child);
    rmSync(temp, { recursive: true, force: true });
  }
});
