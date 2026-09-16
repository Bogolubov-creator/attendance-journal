import { passwordHash } from "../src/management-auth.js";
import { request as httpRequest } from "node:http";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
test("Рабочий сервер не запускается с неподключённой авторизацией", async () => {
  const temp = mkdtempSync("work/production-test-");
  try {
    const child = spawn(process.execPath, ["src/server.js"], {
      env: {
        ...process.env,
        MANAGEMENT_PASSWORD_HASH: passwordHash("test-management-password"),
        DEMO_MODE: "false",
        APP_ORIGIN: "https://attendance.example.edu",
        OIDC_ISSUER: "",
        OIDC_CLIENT_ID: "",
        OIDC_CLIENT_SECRET: "",
        DB_PATH: join(temp, "db.sqlite"),
        PORT: "3102",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let output = "";
    child.stderr.on("data", (s) => (output += s));
    const code = await new Promise((r) => child.on("exit", r));
    assert.notEqual(code, 0);
    assert.match(output, /Заполните параметры университетской авторизации/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

function proxyFetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      url,
      { method: options.method || "GET", headers: options.headers },
      (res) => {
        const chunks = [];
        res.on("data", (b) => chunks.push(b));
        res.on("end", () =>
          resolve(
            new Response(Buffer.concat(chunks), {
              status: res.statusCode,
              headers: res.headers,
            }),
          ),
        );
      },
    );
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}
test("Рабочий выбор сотрудника запускается без OIDC и сохраняет сессию", async () => {
  const temp = mkdtempSync("work/selection-production-");
  const child = spawn(process.execPath, ["src/server.js"], {
    env: {
      ...process.env,
      MANAGEMENT_PASSWORD_HASH: passwordHash("test-management-password"),
      AUTH_MODE: "selection",
      DEMO_MODE: "false",
      REQUIRE_AUTH_CONFIG: "true",
      AUTO_SYNC: "false",
      AUTO_BACKUP: "false",
      APP_ORIGIN: "https://attendance.example.edu",
      OIDC_ISSUER: "",
      OIDC_CLIENT_ID: "",
      OIDC_CLIENT_SECRET: "",
      DB_PATH: join(temp, "db.sqlite"),
      HOST: "127.0.0.1",
      PORT: "3104",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await new Promise((resolve, reject) => {
      child.stdout.once("data", resolve);
      child.once("error", reject);
      child.once("exit", (c) => reject(Error("server exit " + c)));
    });
    const headers = {
      host: "attendance.example.edu",
      origin: "https://attendance.example.edu",
      "content-type": "application/json",
    };
    const r = await proxyFetch("http://127.0.0.1:3104/api/select-login", {
      method: "POST",
      headers,
      body: JSON.stringify({
        role: "office",
        personId: "smirnova",
        password: "test-management-password",
      }),
    });
    assert.equal(r.status, 200, await r.clone().text());
    const cookie = r.headers.get("set-cookie");
    assert.match(cookie, /Secure/);
    assert.match(cookie, /HttpOnly/);
    const session = await (
      await proxyFetch("http://127.0.0.1:3104/api/session", {
        headers: { ...headers, cookie: cookie.split(";")[0] },
      })
    ).json();
    assert.equal(session.user.id, "smirnova");
    assert.equal(
      (
        await proxyFetch("http://127.0.0.1:3104/api/demo-login", {
          method: "POST",
          headers,
          body: "{}",
        })
      ).status,
      404,
    );
  } finally {
    child.kill("SIGTERM");
    await new Promise((r) => child.once("exit", r));
    rmSync(temp, { recursive: true, force: true });
  }
});
