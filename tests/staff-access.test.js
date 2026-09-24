import test from "node:test";
import assert from "node:assert/strict";
import { startServer } from "./staff-server.js";

const PASSWORD = "длинный пароль преподавателя";

// s_test_1 – Юриспруденция, 1 курс (Ахмятжанов), s_test_2 – 2 курс (Смирнова).
// t_test_1 ведёт обоих, t_test_2 – только s_test_2.
async function setup(s) {
  const admin = await s.selectLogin("admin", "gadzhieva");
  for (const [id, year] of [
    ["s_test_1", 1],
    ["s_test_2", 2],
  ]) {
    const r = await s.call(`/api/admin/students/${id}/profile`, {
      method: "PUT",
      cookie: admin,
      body: {
        program: "Юриспруденция",
        year,
        foreignStatus: "confirmed",
        version: 0,
      },
    });
    assert.equal(r.status, 200, await r.clone().text());
  }
  return admin;
}
const grant = (s, cookie, id) =>
  s.call("/api/admin/access/" + id, { method: "POST", cookie });
const teachers = async (s, cookie) =>
  (await s.call("/api/admin/teachers", { cookie })).json();
async function activate(s, invite) {
  const r = await s.call("/api/first-login", {
    method: "POST",
    body: { login: invite.login, code: invite.code, password: PASSWORD },
  });
  assert.equal(r.status, 200, await r.clone().text());
  return s.cookieOf(r);
}

test("Состояние доступа: нет – приглашён до даты – активен с последним входом", async () => {
  const s = await startServer(3123);
  try {
    const admin = await setup(s);
    let t1 = (await teachers(s, admin)).find((t) => t.id === "t_test_1");
    assert.deepEqual(t1.access, { state: "none", login: null });
    assert.equal(t1.canManageAccess, true);

    const r = await grant(s, admin, "t_test_1");
    assert.equal(r.status, 200);
    const invite = await r.json();
    assert.equal(invite.reset, false);
    assert.equal(invite.name, "Преподаватель Первый");
    t1 = (await teachers(s, admin)).find((t) => t.id === "t_test_1");
    assert.equal(t1.access.state, "invited");
    assert.equal(t1.access.login, invite.login);
    assert.ok(t1.access.expires > Date.now() + 6 * 86400000);
    assert.ok(!JSON.stringify(t1).includes(invite.code), "код не в списке");

    await activate(s, invite);
    t1 = (await teachers(s, admin)).find((t) => t.id === "t_test_1");
    assert.equal(t1.access.state, "active");
    assert.ok(t1.access.lastLoginAt);

    // Новый код заменяет прежний неиспользованный.
    const first = await (await grant(s, admin, "t_test_2")).json();
    const second = await (await grant(s, admin, "t_test_2")).json();
    let bad = await s.call("/api/first-login", {
      method: "POST",
      body: { login: first.login, code: first.code, password: PASSWORD },
    });
    assert.equal(bad.status, 403);
    await activate(s, second);

    // Выдача видна в «Последних изменениях», кода в журнале нет.
    const overview = await (
      await s.call("/api/admin/overview", { cookie: admin })
    ).json();
    const actions = overview.audit.map((a) => a.action);
    assert.ok(actions.includes("access.invite"));
    assert.ok(!JSON.stringify(overview.audit).includes(second.code));
  } finally {
    await s.close();
  }
});

test("Права: полный доступ – всем, менеджер – преподавателям своих студентов, остальным 403", async () => {
  const s = await startServer(3123);
  try {
    const admin = await setup(s);
    const manager = await s.selectLogin("office", "akhmyatzhanov");
    const teacher = await s.selectLogin("teacher", "t_test_1");

    let list = await teachers(s, manager);
    assert.equal(list.find((t) => t.id === "t_test_1").canManageAccess, true);
    assert.equal(list.find((t) => t.id === "t_test_2").canManageAccess, false);
    assert.equal((await grant(s, manager, "t_test_1")).status, 200);
    // Перевыдать действующий код или сбросить пароль менеджер не может.
    assert.equal((await grant(s, manager, "t_test_1")).status, 403);
    list = await teachers(s, manager);
    assert.equal(list.find((t) => t.id === "t_test_1").canManageAccess, false);
    assert.equal((await grant(s, manager, "t_test_2")).status, 403);
    assert.equal((await grant(s, manager, "chinkova")).status, 403);
    assert.equal((await grant(s, manager, "smirnova")).status, 403);
    assert.equal((await grant(s, teacher, "t_test_1")).status, 403);

    for (const id of ["t_test_2", "chinkova", "smirnova"])
      assert.equal((await grant(s, admin, id)).status, 200, id);
    assert.equal((await grant(s, admin, "nobody")).status, 404);

    // Блок сотрудников офиса – только полному доступу.
    const staff = await s.call("/api/admin/staff-access", { cookie: admin });
    assert.equal(staff.status, 200);
    const people = await staff.json();
    assert.equal(people.length, 10);
    assert.equal(
      people.find((p) => p.id === "chinkova").access.state,
      "invited",
    );
    assert.equal(
      (await s.call("/api/admin/staff-access", { cookie: manager })).status,
      403,
    );
  } finally {
    await s.close();
  }
});

test("Сброс пароля: прежний пароль не работает, все сессии закрыты, новый код действует", async () => {
  const s = await startServer(3123);
  try {
    const admin = await setup(s);
    const invite = await (await grant(s, admin, "t_test_1")).json();
    await activate(s, invite);
    const login = (remember) =>
      s.call("/api/login", {
        method: "POST",
        body: { login: invite.login, password: PASSWORD, remember },
      });
    const short = s.cookieOf(await login(false));
    const long = s.cookieOf(await login(true));
    for (const cookie of [short, long])
      assert.equal((await s.call("/api/daily", { cookie })).status, 200);

    const r = await grant(s, admin, "t_test_1");
    const reset = await r.json();
    assert.equal(reset.reset, true);
    assert.equal(reset.login, invite.login);
    for (const cookie of [short, long])
      assert.equal((await s.call("/api/daily", { cookie })).status, 401);
    assert.equal((await login(false)).status, 403);
    await activate(s, reset);

    const db = s.db();
    const entry = db
      .prepare("SELECT * FROM audit WHERE action='access.reset'")
      .get();
    db.close();
    assert.equal(entry.actor, "Гаджиева Альбина Омаровна");
    assert.equal(entry.label, "Преподаватель Первый");
    assert.ok(!JSON.stringify(entry).includes(reset.code));
  } finally {
    await s.close();
  }
});

test("Переименование не меняет логин, удаление преподавателя убирает его доступ", async () => {
  const s = await startServer(3123);
  try {
    const admin = await setup(s);
    const invite = await (await grant(s, admin, "t_test_1")).json();
    await activate(s, invite);
    let r = await s.call("/api/admin/teachers/t_test_1", {
      method: "PUT",
      cookie: admin,
      body: { name: "Преподаватель Переименованный" },
    });
    assert.equal(r.status, 200);
    const t1 = (await teachers(s, admin)).find((t) => t.id === "t_test_1");
    assert.equal(t1.access.login, invite.login);
    r = await s.call("/api/login", {
      method: "POST",
      body: { login: invite.login, password: PASSWORD },
    });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).user.name, "Преподаватель Переименованный");

    // Новый преподаватель без студентов: выдать доступ, войти, удалить.
    const added = await (
      await s.call("/api/admin/teachers", {
        method: "POST",
        cookie: admin,
        body: { name: "Новиков Николай Николаевич" },
      })
    ).json();
    const fresh = await (await grant(s, admin, added.id)).json();
    assert.equal(fresh.login, "novikov.nn");
    const session = await activate(s, fresh);
    const again = await (await grant(s, admin, added.id)).json();
    r = await s.call("/api/admin/teachers/" + added.id, {
      method: "DELETE",
      cookie: admin,
    });
    assert.equal(r.status, 200);
    assert.equal((await s.call("/api/daily", { cookie: session })).status, 401);
    r = await s.call("/api/first-login", {
      method: "POST",
      body: { login: again.login, code: again.code, password: PASSWORD },
    });
    assert.equal(r.status, 403);
    r = await s.call("/api/login", {
      method: "POST",
      body: { login: fresh.login, password: PASSWORD },
    });
    assert.equal(r.status, 403);
  } finally {
    await s.close();
  }
});

test("Менеджер не захватывает учётную запись преподавателя, привязав его к своему студенту", async () => {
  const s = await startServer(3123);
  try {
    const admin = await setup(s);
    const invite = await (await grant(s, admin, "t_test_2")).json();
    const teacherSession = await activate(s, invite);
    const manager = await s.selectLogin("office", "akhmyatzhanov");
    let r = await s.call("/api/admin/enrollments", {
      method: "POST",
      cookie: manager,
      body: { studentId: "s_test_1", teacherId: "t_test_2", course: "Логика" },
    });
    assert.equal(r.status, 200, "связь со своим студентом – законное право");
    r = await grant(s, manager, "t_test_2");
    assert.equal(r.status, 403);
    assert.equal(
      (await s.call("/api/daily", { cookie: teacherSession })).status,
      200,
      "сессия преподавателя не тронута",
    );
  } finally {
    await s.close();
  }
});
