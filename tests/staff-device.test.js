import test from "node:test";
import assert from "node:assert/strict";
import { startServer } from "./staff-server.js";

const PASSWORD = "пароль преподавателя журнала";
const device = (r) =>
  r.headers
    .getSetCookie()
    .find((c) => c.startsWith("journal_device="))
    ?.split(";")[0];

async function activeTeacher(s) {
  const admin = await s.selectLogin("admin", "gadzhieva");
  const invite = await (
    await s.call("/api/admin/access/t_test_1", {
      method: "POST",
      cookie: admin,
    })
  ).json();
  const r = await s.call("/api/first-login", {
    method: "POST",
    body: { login: invite.login, code: invite.code, password: PASSWORD },
  });
  assert.equal(r.status, 200);
  return { admin, login: invite.login, device: device(r), firstLogin: r };
}
const login = (s, body, cookie) =>
  s.call("/api/login", { method: "POST", body, cookie });
async function lockFromStranger(s, name) {
  for (let i = 0; i < 5; i++)
    await login(s, { login: name, password: "чужая попытка " + i });
}

test("Чужие попытки закрывают вход незнакомым устройствам, но не знакомому", async () => {
  const s = await startServer(3132);
  try {
    const t = await activeTeacher(s);
    const cookie = t.firstLogin.headers.getSetCookie().join("; ");
    assert.match(cookie, /journal_device=[A-Za-z0-9_-]{43}/);
    assert.match(
      t.firstLogin.headers
        .getSetCookie()
        .find((c) => c.startsWith("journal_device=")),
      /HttpOnly/i,
    );
    const db = s.db();
    const token = t.device.split("=")[1];
    const dump = JSON.stringify(
      db.prepare("SELECT * FROM staff_devices").all(),
    );
    db.close();
    assert.ok(!dump.includes(token), "в базе только хеш отметки");

    await lockFromStranger(s, t.login);
    assert.equal(
      (await login(s, { login: t.login, password: PASSWORD })).status,
      429,
      "незнакомое устройство закрыто",
    );
    const r = await login(s, { login: t.login, password: PASSWORD }, t.device);
    assert.equal(r.status, 200, "со своего устройства входит");
  } finally {
    await s.close();
  }
});

test("Ошибки со знакомого устройства не блокируют учётную запись; после 5 подряд отметка гаснет", async () => {
  const s = await startServer(3132);
  try {
    const t = await activeTeacher(s);
    for (let i = 0; i < 4; i++)
      await login(s, { login: t.login, password: "опечатка " + i }, t.device);
    assert.equal(
      (await login(s, { login: t.login, password: PASSWORD })).status,
      200,
      "учётная запись не закрыта для других устройств",
    );
    for (let i = 0; i < 5; i++)
      await login(s, { login: t.login, password: "опечатка " + i }, t.device);
    await lockFromStranger(s, t.login);
    assert.equal(
      (await login(s, { login: t.login, password: PASSWORD }, t.device)).status,
      429,
      "отметка устройства больше не действует",
    );
  } finally {
    await s.close();
  }
});

test("Сброс пароля делает прежние отметки устройств недействительными", async () => {
  const s = await startServer(3132);
  try {
    const t = await activeTeacher(s);
    const reset = await (
      await s.call("/api/admin/access/t_test_1", {
        method: "POST",
        cookie: t.admin,
      })
    ).json();
    // Новый пароль задаётся с другого устройства – прежняя отметка не участвует.
    const r = await s.call("/api/first-login", {
      method: "POST",
      body: { login: reset.login, code: reset.code, password: PASSWORD },
    });
    assert.equal(r.status, 200);
    await lockFromStranger(s, t.login);
    assert.equal(
      (await login(s, { login: t.login, password: PASSWORD }, t.device)).status,
      429,
    );
  } finally {
    await s.close();
  }
});
