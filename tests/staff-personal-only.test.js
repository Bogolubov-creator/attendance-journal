import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { startServer, SHARED_PASSWORD } from "./staff-server.js";

const PASSWORD = "личный пароль преподавателя";

test("День X: общий пароль, выбор из списка и демо-вход сотрудников отключаются, режим переживает перезапуск и снимается скриптом", async () => {
  const s = await startServer(3128);
  try {
    // До включения всё как раньше: выбор из списка работает, список ФИО отдаётся.
    const admin = await s.selectLogin("admin", "gadzhieva");
    const manager = await s.selectLogin("office", "akhmyatzhanov");
    let session = await (await s.call("/api/session")).json();
    assert.equal(session.personalOnly, false);
    assert.ok(session.teachers.length > 0 && session.managers.length > 0);

    const invite = await (
      await s.call("/api/admin/access/t_test_1", {
        method: "POST",
        cookie: admin,
      })
    ).json();
    await s.call("/api/first-login", {
      method: "POST",
      body: { login: invite.login, code: invite.code, password: PASSWORD },
    });

    let r = await s.call("/api/admin/personal-only", { cookie: admin });
    assert.deepEqual(await r.json(), { enabled: false, withoutPassword: 11 });
    assert.equal(
      (await s.call("/api/admin/personal-only", { cookie: manager })).status,
      403,
    );
    r = await s.call("/api/admin/personal-only", {
      method: "POST",
      cookie: admin,
      body: {},
    });
    assert.equal(r.status, 400, "без подтверждения не включается");
    r = await s.call("/api/admin/personal-only", {
      method: "POST",
      cookie: admin,
      body: { confirm: true },
    });
    assert.equal(r.status, 200);

    // Сессии по общему паролю закрыты, новые не выдаются.
    assert.equal(
      (await s.call("/api/admin/overview", { cookie: admin })).status,
      401,
    );
    r = await s.call("/api/select-login", {
      method: "POST",
      body: { role: "admin", personId: "gadzhieva", password: SHARED_PASSWORD },
    });
    assert.equal(r.status, 403);
    for (const body of [
      { role: "admin" },
      { role: "teacher", teacherId: "t_test_1" },
    ]) {
      r = await s.call("/api/demo-login", {
        method: "POST",
        body: { ...body, password: SHARED_PASSWORD },
      });
      assert.equal(r.status, 403, body.role);
    }
    session = await (await s.call("/api/session")).json();
    assert.equal(session.personalOnly, true);
    assert.deepEqual(session.teachers, []);
    assert.deepEqual(session.managers, []);

    // Личный вход работает; демо-вход студентом в тестовой базе не затронут.
    const login = () =>
      s.call("/api/login", {
        method: "POST",
        body: { login: invite.login, password: PASSWORD },
      });
    assert.equal((await login()).status, 200);
    r = await s.call("/api/demo-login", {
      method: "POST",
      body: {
        role: "student",
        studentId: "s_test_1",
        password: SHARED_PASSWORD,
      },
    });
    assert.equal(r.status, 200);
    assert.equal(
      (await s.call("/api/student/profile", { cookie: s.cookieOf(r) })).status,
      200,
    );

    await s.restart();
    session = await (await s.call("/api/session")).json();
    assert.equal(session.personalOnly, true, "режим переживает перезапуск");

    const out = execFileSync(
      process.execPath,
      ["scripts/allow-shared-password.mjs"],
      { env: { ...process.env, DB_PATH: s.dbPath }, encoding: "utf8" },
    );
    assert.match(out, /снят/);
    session = await (await s.call("/api/session")).json();
    assert.equal(session.personalOnly, false);
    await s.selectLogin("admin", "gadzhieva");

    const db = s.db();
    const labels = db
      .prepare("SELECT label FROM audit WHERE action='access.mode' ORDER BY id")
      .all()
      .map((e) => e.label);
    db.close();
    assert.equal(labels.length, 2);
    assert.match(labels[0], /только по личным паролям; без пароля: 11/);
  } finally {
    await s.close();
  }
});
