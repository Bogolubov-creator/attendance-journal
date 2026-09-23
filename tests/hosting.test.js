import { passwordHash } from "../src/management-auth.js";
import test from "node:test";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

function startServer(env) {
  const child = spawn(process.execPath, ["src/server.js"], {
    env: {
      ...process.env,
      ROSTER_PATH: "tests/fixtures/roster.json",
      MANAGEMENT_PASSWORD_HASH: passwordHash("test-management-password"),
      DEMO_MODE: "true",
      AUTO_BACKUP: "false",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    child.stdout.once("data", () => resolve(child));
    child.once("error", reject);
    child.once("exit", (code) => reject(Error("server exit " + code)));
  });
}

async function stopServer(child) {
  if (child.exitCode !== null || child.signalCode) return;
  child.kill("SIGTERM");
  await new Promise((r) => child.once("exit", r));
}

test("За прокси попытки пароля считаются по адресу посетителя", async () => {
  const origin = "http://127.0.0.1:3109";
  const temp = mkdtempSync(join(tmpdir(), "attendance-proxy-"));
  const child = await startServer({
    TRUST_PROXY: "1",
    DB_PATH: join(temp, "db.sqlite"),
    PORT: "3109",
    APP_ORIGIN: origin,
  });
  const login = (address) =>
    fetch(origin + "/api/select-login", {
      method: "POST",
      headers: {
        origin,
        "content-type": "application/json",
        "x-forwarded-for": address,
      },
      body: JSON.stringify({
        role: "office",
        personId: "smirnova",
        password: "неверный",
      }),
    });
  try {
    for (let i = 0; i < 5; i++)
      assert.equal((await login("10.0.0.1")).status, 403);
    assert.equal((await login("10.0.0.1")).status, 429);
    // Посетителя с другим адресом чужие попытки не блокируют.
    assert.equal((await login("10.0.0.2")).status, 403);
  } finally {
    await stopServer(child);
    rmSync(temp, { recursive: true, force: true });
  }
});

test("Остаются только последние BACKUP_KEEP резервных копий", async () => {
  const temp = mkdtempSync(join(tmpdir(), "attendance-backup-keep-"));
  const dir = join(temp, "backups");
  mkdirSync(dir, { recursive: true });
  for (const day of ["01", "02", "03"])
    writeFileSync(
      join(dir, `attendance-2026-01-${day}T00-00-00.000Z.sqlite`),
      "",
    );
  const child = await startServer({
    AUTO_BACKUP: "true",
    BACKUP_KEEP: "2",
    BACKUP_DIR: dir,
    DB_PATH: join(temp, "db.sqlite"),
    PORT: "3110",
    APP_ORIGIN: "http://127.0.0.1:3110",
  });
  try {
    let files = [];
    for (let i = 0; i < 100; i++) {
      files = readdirSync(dir).filter((name) => name.endsWith(".sqlite"));
      if (files.length === 2) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(files.length, 2, files.join(", "));
    assert.ok(
      files.includes("attendance-2026-01-03T00-00-00.000Z.sqlite"),
      "самая свежая из прежних копий остаётся",
    );
    assert.ok(
      !files.includes("attendance-2026-01-01T00-00-00.000Z.sqlite"),
      "самая старая копия удалена",
    );
  } finally {
    await stopServer(child);
    rmSync(temp, { recursive: true, force: true });
  }
});
