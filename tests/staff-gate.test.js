import test from "node:test";
import assert from "node:assert/strict";
import { startServer } from "./staff-server.js";
import { staffAccounts, hashGate } from "../src/staff-accounts.js";

const PASSWORD = "пароль преподавателя журнала";

test("Очередь проверок: не больше 4 одновременно, 16 ждут, остальным 429", async () => {
  let active = 0,
    peak = 0;
  const releases = [];
  const job = () =>
    hashGate(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => releases.push(r));
      active--;
      return "ok";
    });
  const jobs = Array.from({ length: 21 }, job);
  const results = Promise.allSettled(jobs);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(releases.length, 4, "одновременно работают четыре");
  // 21-й не поместился: 4 работают, 16 ждут.
  const settled = await Promise.race([
    jobs[20].then(
      () => "ok",
      (e) => e,
    ),
    new Promise((r) => setTimeout(() => r("pending"), 20)),
  ]);
  assert.equal(settled.status, 429);
  while (releases.length) {
    releases.shift()();
    await new Promise((r) => setTimeout(r, 1));
  }
  const all = await results;
  assert.equal(all.filter((r) => r.status === "fulfilled").length, 20);
  assert.equal(peak, 4);
});

test("Поток входов с любыми логинами не останавливает сервер, лишним – «Сервер занят»", async () => {
  const s = await startServer(3130);
  try {
    const burst = Array.from({ length: 40 }, (_, i) =>
      s.call("/api/login", {
        method: "POST",
        body: { login: "nobody" + i, password: "x".repeat(256) },
      }),
    );
    await new Promise((r) => setTimeout(r, 30));
    const started = Date.now();
    const health = await fetch(s.origin + "/healthz", {
      headers: { origin: s.origin },
    });
    const healthMs = Date.now() - started;
    assert.equal(health.status, 200);
    assert.ok(healthMs < 500, `/healthz ответил за ${healthMs} мс`);
    const statuses = await Promise.all(
      burst.map(async (r) => {
        const res = await r;
        return [res.status, (await res.json()).error];
      }),
    );
    const busy = statuses.filter(([code]) => code === 429);
    assert.ok(busy.length > 0, "лишние входы получили 429");
    assert.match(busy[0][1], /Сервер занят/);
    assert.ok(statuses.some(([code]) => code === 403));
  } finally {
    await s.close();
  }
});

test("Один код двумя запросами разом задаёт пароль один раз; параллельные ошибки считаются все", async () => {
  const s = await startServer(3130);
  try {
    const db = s.db();
    const invite = staffAccounts(db).issueInvite({
      id: "t_test_1",
      name: "Преподаватель Первый",
    });
    db.close();
    const redeem = (password) =>
      s.call("/api/first-login", {
        method: "POST",
        body: { login: invite.login, code: invite.code, password },
      });
    const [a, b] = await Promise.all([
      redeem(PASSWORD),
      redeem("другой пароль журнала"),
    ]);
    assert.deepEqual(
      [a.status, b.status].sort(),
      [200, 403],
      "код сработал ровно один раз",
    );

    const wrong = Array.from({ length: 5 }, (_, i) =>
      s.call("/api/login", {
        method: "POST",
        body: { login: invite.login, password: "подбираю " + i },
      }),
    );
    assert.deepEqual(
      (await Promise.all(wrong)).map((r) => r.status),
      [403, 403, 403, 403, 403],
    );
    const winner = a.status === 200 ? PASSWORD : "другой пароль журнала";
    const locked = await s.call("/api/login", {
      method: "POST",
      body: { login: invite.login, password: winner },
    });
    assert.equal(locked.status, 429, "пять параллельных ошибок закрыли вход");
  } finally {
    await s.close();
  }
});
