// Общее для тестов личных паролей: сервер на временной базе, запросы, скрипт кода.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { passwordHash } from "../src/management-auth.js";

export const SHARED_PASSWORD = "test-management-password";

export async function startServer(port, env = {}) {
  const temp = mkdtempSync(join(tmpdir(), "attendance-staff-"));
  const dbPath = join(temp, "db.sqlite");
  const origin = `http://127.0.0.1:${port}`;
  let child;
  const launch = async () => {
    child = spawn(process.execPath, ["src/server.js"], {
      env: {
        ...process.env,
        ROSTER_PATH: "tests/fixtures/roster.json",
        MANAGEMENT_PASSWORD_HASH: passwordHash(SHARED_PASSWORD),
        DEMO_MODE: "true",
        AUTO_BACKUP: "false",
        DB_PATH: dbPath,
        PORT: String(port),
        APP_ORIGIN: origin,
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise((resolve, reject) => {
      child.stdout.once("data", resolve);
      child.once("exit", (c) => reject(Error("server exit " + c)));
    });
  };
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    await new Promise((r) => child.once("exit", r));
  };
  await launch();
  // Запрос с тем же Origin, что у приложения; cookie – строка «journal=…».
  const call = (path, { method = "GET", body, cookie } = {}) =>
    fetch(origin + path, {
      method,
      headers: {
        origin,
        "content-type": "application/json",
        ...(cookie ? { cookie } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const cookieOf = (r) => r.headers.get("set-cookie")?.split(";")[0];
  const db = () => new DatabaseSync(dbPath);
  // Серверный скрипт первого доступа администратора: возвращает логин и код.
  const inviteAdmin = (id) => {
    const out = execFileSync(
      process.execPath,
      ["scripts/invite-admin.mjs", id],
      { env: { ...process.env, DB_PATH: dbPath }, encoding: "utf8" },
    );
    return {
      login: out.match(/Логин: (\S+)/)[1],
      code: out.match(/Код приглашения: (\S+)/)[1],
      out,
    };
  };
  const selectLogin = async (role, personId) => {
    const r = await call("/api/select-login", {
      method: "POST",
      body: { role, personId, password: SHARED_PASSWORD },
    });
    assert.equal(r.status, 200, await r.clone().text());
    return cookieOf(r);
  };
  return {
    origin,
    dbPath,
    call,
    cookieOf,
    db,
    inviteAdmin,
    selectLogin,
    restart: async () => {
      await stop();
      await launch();
    },
    close: async () => {
      await stop();
      rmSync(temp, { recursive: true, force: true });
    },
  };
}
