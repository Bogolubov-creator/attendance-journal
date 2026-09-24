import test from "node:test";
import assert from "node:assert/strict";
import { startServer } from "./staff-server.js";

const OLD = "первый пароль преподавателя";
const NEW = "второй пароль преподавателя";

test("Смена своего пароля: нужен текущий, правила пароля, прочие сессии закрываются, текущая остаётся", async () => {
  const s = await startServer(3125);
  try {
    const admin = await s.selectLogin("admin", "gadzhieva");
    const invite = await (
      await s.call("/api/admin/access/t_test_1", {
        method: "POST",
        cookie: admin,
      })
    ).json();
    let r = await s.call("/api/first-login", {
      method: "POST",
      body: { login: invite.login, code: invite.code, password: OLD },
    });
    const here = s.cookieOf(r);
    r = await s.call("/api/login", {
      method: "POST",
      body: { login: invite.login, password: OLD, remember: true },
    });
    const phone = s.cookieOf(r);
    const change = (cookie, current, next) =>
      s.call("/api/account/password", {
        method: "POST",
        cookie,
        body: { current, next },
      });

    r = await change(here, "не тот пароль", NEW);
    assert.equal(r.status, 403);
    assert.match((await r.json()).error, /Текущий пароль указан неверно/);
    r = await change(here, OLD, "коротко");
    assert.equal(r.status, 400);
    r = await change(here, OLD, "qwertyuiop");
    assert.equal(r.status, 400);
    assert.equal(
      (await change(admin, OLD, NEW)).status,
      403,
      "вход по общему паролю – без смены личного",
    );

    r = await change(here, OLD, NEW);
    assert.equal(r.status, 200, await r.clone().text());
    const renewed = s.cookieOf(r);
    assert.equal((await s.call("/api/daily", { cookie: renewed })).status, 200);
    assert.equal((await s.call("/api/daily", { cookie: phone })).status, 401);
    assert.equal((await s.call("/api/daily", { cookie: here })).status, 401);

    const login = (password) =>
      s.call("/api/login", {
        method: "POST",
        body: { login: invite.login, password },
      });
    assert.equal((await login(OLD)).status, 403);
    assert.equal((await login(NEW)).status, 200);

    const db = s.db();
    const entry = db
      .prepare("SELECT * FROM audit WHERE action='access.password'")
      .get();
    db.close();
    assert.equal(entry.actor, "Преподаватель Первый");
    assert.ok(!JSON.stringify(entry).includes(NEW));
  } finally {
    await s.close();
  }
});

test("Неверный текущий пароль идёт в счётчик блокировки", async () => {
  const s = await startServer(3125);
  try {
    const admin = await s.selectLogin("admin", "gadzhieva");
    const invite = await (
      await s.call("/api/admin/access/t_test_1", {
        method: "POST",
        cookie: admin,
      })
    ).json();
    const r = await s.call("/api/first-login", {
      method: "POST",
      body: { login: invite.login, code: invite.code, password: OLD },
    });
    const cookie = s.cookieOf(r);
    for (let i = 0; i < 5; i++)
      await s.call("/api/account/password", {
        method: "POST",
        cookie,
        body: { current: "подбираю " + i, next: NEW },
      });
    const locked = await s.call("/api/login", {
      method: "POST",
      body: { login: invite.login, password: OLD },
    });
    assert.equal(locked.status, 429);
  } finally {
    await s.close();
  }
});
