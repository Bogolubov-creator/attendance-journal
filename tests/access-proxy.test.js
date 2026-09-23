import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GATEWAY_PORT = 3141;
const APP_PORT = 3142;

function startGateway(configPath) {
  const child = spawn(process.execPath, ["scripts/access-proxy.mjs"], {
    env: {
      ...process.env,
      ACCESS_CONFIG: configPath,
      APP_HOST: "127.0.0.1",
      GATEWAY_PORT: String(GATEWAY_PORT),
      APP_PORT: String(APP_PORT),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    child.stdout.once("data", () => resolve(child));
    child.once("error", reject);
    child.once("exit", (code) => reject(Error("gateway exit " + code)));
  });
}

function request(headers) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port: GATEWAY_PORT, path: "/", headers },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

const basic = (user, password) =>
  "Basic " + Buffer.from(`${user}:${password}`).toString("base64");

test("gateway counts wrong passwords by socket address, not X-Forwarded-For", async () => {
  const dir = mkdtempSync(join(tmpdir(), "access-proxy-"));
  const configPath = join(dir, "access.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      username: "faculty",
      passwordHash: createHash("sha256").update("right-password").digest("hex"),
    }),
  );
  let upstreamHost = "";
  const app = http.createServer((req, res) => {
    upstreamHost = req.headers.host;
    res.end("app ok");
  });
  await new Promise((resolve) => app.listen(APP_PORT, "127.0.0.1", resolve));
  let gateway;
  try {
    gateway = await startGateway(configPath);
    const ok = await request({
      authorization: basic("faculty", "right-password"),
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.body, "app ok");
    assert.equal(upstreamHost, `127.0.0.1:${APP_PORT}`);

    for (let i = 1; i <= 9; i++) {
      const res = await request({
        authorization: basic("faculty", "wrong"),
        "x-forwarded-for": `10.0.0.${i}`,
      });
      assert.equal(res.status, 401);
    }
    // Правильный пароль не снимает счётчик: за туннелем адрес у всех один,
    // и сброс дал бы подбирающему новые попытки после каждого входа сотрудника.
    const between = await request({
      authorization: basic("faculty", "right-password"),
    });
    assert.equal(between.status, 200);

    const statuses = [];
    for (let i = 10; i <= 11; i++) {
      const res = await request({
        authorization: basic("faculty", "wrong"),
        "x-forwarded-for": `192.168.1.${i}`,
      });
      statuses.push(res.status);
    }
    assert.deepEqual(statuses, [401, 429]);
  } finally {
    gateway?.kill("SIGTERM");
    await new Promise((resolve) => app.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
