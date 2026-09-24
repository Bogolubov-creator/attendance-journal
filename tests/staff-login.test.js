import test from "node:test";
import assert from "node:assert/strict";
import { startServer } from "./staff-server.js";
import { staffAccounts } from "../src/staff-accounts.js";

const TEACHER_PASSWORD = "мел и доска навсегда";
const ADMIN_PASSWORD = "журнал без общего пароля";

// Преподавателю код выдаётся напрямую в базе (выдача через сайт – задача 03),
// администратору – серверным скриптом; пароли задаются первым входом.
async function withAccounts(s) {
  const db = s.db();
  const teacher = staffAccounts(db).issueInvite({
    id: "t_test_1",
    name: "Преподаватель Первый",
  });
  db.close();
  const admin = s.inviteAdmin("gadzhieva");
  for (const [who, password] of [
    [teacher, TEACHER_PASSWORD],
    [admin, ADMIN_PASSWORD],
  ]) {
    const r = await s.call("/api/first-login", {
      method: "POST",
      body: { login: who.login, code: who.code, password },
    });
    assert.equal(r.status, 200, await r.clone().text());
  }
  return { teacher: teacher.login, admin: admin.login };
}
const login = (s, body) => s.call("/api/login", { method: "POST", body });
const maxAge = (r) =>
  Number(r.headers.get("set-cookie").match(/Max-Age=(\d+)/)[1]);

test("Вход по логину и паролю: кабинет своей роли, срок сессии по роли и отметке", async () => {
  const s = await startServer(3122);
  try {
    const logins = await withAccounts(s);
    let r = await login(s, {
      login: logins.teacher.toUpperCase(),
      password: TEACHER_PASSWORD,
    });
    assert.equal(r.status, 200, await r.clone().text());
    assert.equal((await r.json()).user.role, "teacher");
    assert.equal(maxAge(r), 8 * 3600);
    const teacherCookie = s.cookieOf(r);
    assert.equal(
      (await s.call("/api/daily", { cookie: teacherCookie })).status,
      200,
    );

    r = await login(s, {
      login: logins.teacher,
      password: TEACHER_PASSWORD,
      remember: true,
    });
    assert.equal(maxAge(r), 30 * 86400);
    const db = s.db();
    const longest = db.prepare("SELECT max(expires) e FROM sessions").get().e;
    assert.ok(longest > Date.now() + 29 * 86400000);

    r = await login(s, {
      login: logins.admin,
      password: ADMIN_PASSWORD,
      remember: true,
    });
    assert.equal((await r.json()).user.role, "admin");
    assert.equal(maxAge(r), 8 * 3600, "полному доступу – не больше 8 часов");
    const adminCookie = s.cookieOf(r);

    const entries = db
      .prepare("SELECT actor FROM audit WHERE action='access.login'")
      .all()
      .map((e) => e.actor);
    assert.deepEqual(entries, [
      "Преподаватель Первый",
      "Преподаватель Первый",
      "Гаджиева Альбина Омаровна",
    ]);
    const last = db
      .prepare(
        "SELECT lastLoginAt FROM staff_accounts WHERE personId='t_test_1'",
      )
      .get().lastLoginAt;
    assert.ok(Date.now() - Date.parse(last) < 60000);
    db.close();
    const overview = await (
      await s.call("/api/admin/overview", { cookie: adminCookie })
    ).json();
    assert.ok(
      !overview.audit.some((a) => a.action === "access.login"),
      "входы не вытесняют правки реестра",
    );
  } finally {
    await s.close();
  }
});

test("Неверный пароль и несуществующий логин неразличимы", async () => {
  const s = await startServer(3122);
  try {
    const logins = await withAccounts(s);
    const wrong = await login(s, {
      login: logins.teacher,
      password: "не тот пароль",
    });
    const missing = await login(s, {
      login: "nobody.xx",
      password: "не тот пароль",
    });
    assert.equal(wrong.status, 403);
    assert.equal(missing.status, wrong.status);
    assert.deepEqual(await missing.json(), await wrong.json());
  } finally {
    await s.close();
  }
});

test("5 неверных паролей закрывают только эту учётную запись на 15 минут", async () => {
  const s = await startServer(3122);
  try {
    const logins = await withAccounts(s);
    for (let i = 0; i < 5; i++)
      assert.equal(
        (await login(s, { login: logins.teacher, password: "подбираю " + i }))
          .status,
        403,
      );
    let r = await login(s, {
      login: logins.teacher,
      password: TEACHER_PASSWORD,
    });
    assert.equal(r.status, 429);
    assert.match((await r.json()).error, /закрыт на 15 минут/);
    r = await login(s, { login: logins.admin, password: ADMIN_PASSWORD });
    assert.equal(r.status, 200, "другая учётная запись входит");

    const db = s.db();
    db.prepare(
      "UPDATE staff_accounts SET lockedUntil=? WHERE personId='t_test_1'",
    ).run(Date.now() - 1);
    db.close();
    r = await login(s, { login: logins.teacher, password: TEACHER_PASSWORD });
    assert.equal(r.status, 200, "после окончания блокировки вход работает");
  } finally {
    await s.close();
  }
});

test("Чужие неверные попытки не закрывают вход остальным и «Первый вход» приглашённому", async () => {
  const s = await startServer(3122);
  try {
    const logins = await withAccounts(s);
    for (let i = 0; i < 100; i++)
      assert.equal(
        (await login(s, { login: "spray" + i, password: "пароль-кандидат" }))
          .status,
        403,
      );
    let r = await login(s, { login: logins.admin, password: ADMIN_PASSWORD });
    assert.equal(r.status, 200, "общего потолка нет");

    // Приглашённый без пароля: неверные входы под его логином не мешают первому входу.
    const db = s.db();
    const invite = staffAccounts(db).issueInvite({
      id: "t_test_2",
      name: "Преподаватель Второй",
    });
    db.close();
    for (let i = 0; i < 6; i++)
      await login(s, { login: invite.login, password: "подбираю " + i });
    r = await s.call("/api/first-login", {
      method: "POST",
      body: {
        login: invite.login,
        code: invite.code,
        password: TEACHER_PASSWORD,
      },
    });
    assert.equal(r.status, 200, await r.clone().text());
  } finally {
    await s.close();
  }
});
