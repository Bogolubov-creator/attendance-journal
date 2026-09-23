import { passwordHash } from "../src/management-auth.js";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const origin = "http://127.0.0.1:3113";
const temp = mkdtempSync(join(tmpdir(), "attendance-account-"));
const call = (path, options = {}) =>
  fetch(origin + path, {
    method: options.method || "GET",
    headers: {
      origin,
      "content-type": "application/json",
      ...(options.cookie ? { cookie: options.cookie } : {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
const login = async (role, personId) => {
  const r = await call("/api/select-login", {
    method: "POST",
    body: { role, personId, password: "test-management-password" },
  });
  assert.equal(r.status, 200, await r.clone().text());
  return r.headers.get("set-cookie").split(";")[0];
};

test("Привязка учётной записи студента", async (t) => {
  const child = spawn(process.execPath, ["src/server.js"], {
    env: {
      ...process.env,
      ROSTER_PATH: "tests/fixtures/roster.json",
      MANAGEMENT_PASSWORD_HASH: passwordHash("test-management-password"),
      DEMO_MODE: "true",
      AUTO_BACKUP: "false",
      DB_PATH: join(temp, "db.sqlite"),
      PORT: "3113",
      APP_ORIGIN: origin,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    child.stdout.once("data", resolve);
    child.once("exit", (c) => reject(Error("server exit " + c)));
  });
  try {
    const admin = await login("admin", "gadzhieva");
    const students = await (
      await call("/api/admin/overview?from=2026-09-01&to=2026-09-01", {
        cookie: admin,
      })
    ).json();
    const studentId = students.students[0].id;

    await t.test("Полный доступ связывает учётку", async () => {
      const r = await call("/api/admin/students/" + studentId + "/account", {
        method: "PUT",
        cookie: admin,
        body: { externalId: "hse-12345" },
      });
      assert.equal(r.status, 200, await r.clone().text());
    });

    await t.test("Один идентификатор нельзя дать двум студентам", async () => {
      const other = students.students[1].id;
      const r = await call("/api/admin/students/" + other + "/account", {
        method: "PUT",
        cookie: admin,
        body: { externalId: "hse-12345" },
      });
      assert.equal(r.status, 409);
    });

    await t.test("Пустой идентификатор отклоняется", async () => {
      const r = await call("/api/admin/students/" + studentId + "/account", {
        method: "PUT",
        cookie: admin,
        body: { externalId: "   " },
      });
      assert.equal(r.status, 400);
    });

    await t.test("Отвязка снимает связь", async () => {
      const r = await call("/api/admin/students/" + studentId + "/account", {
        method: "DELETE",
        cookie: admin,
      });
      assert.equal(r.status, 200);
      const repeat = await call(
        "/api/admin/students/" + students.students[1].id + "/account",
        { method: "PUT", cookie: admin, body: { externalId: "hse-12345" } },
      );
      assert.equal(repeat.status, 200);
    });

    await t.test("Привязка попадает в журнал изменений", async () => {
      const overview = await (
        await call("/api/admin/overview?from=2026-09-01&to=2026-09-01", {
          cookie: admin,
        })
      ).json();
      assert.ok(
        overview.audit.some((row) => row.action.startsWith("account.")),
        JSON.stringify(overview.audit),
      );
    });

    await t.test(
      "Сотрудник видит своих студентов без учётной записи",
      async () => {
        const data = await (
          await call("/api/admin/students-without-account", { cookie: admin })
        ).json();
        assert.ok(Array.isArray(data.students));
        const linked = students.students[1].id;
        assert.ok(
          !data.students.some((s) => s.id === linked),
          "связанный не показывается",
        );
        assert.ok(
          data.students.every((s) => s.name),
          "в списке есть ФИО для связывания",
        );
      },
    );

    await t.test("Менеджер видит в списке только своих студентов", async () => {
      const manager = await login("office", "smirnova");
      const data = await (
        await call("/api/admin/students-without-account", { cookie: manager })
      ).json();
      assert.ok(
        data.students.every((s) => s.manager?.id === "smirnova"),
        JSON.stringify(data.students),
      );
    });

    await t.test(
      "Демо-вход студентом даёт роль student и свой id",
      async () => {
        const studentId = students.students[0].id;
        const link = await call(
          "/api/admin/students/" + studentId + "/account",
          {
            method: "PUT",
            cookie: admin,
            body: { externalId: "hse-777" },
          },
        );
        assert.equal(link.status, 200, await link.clone().text());
        const r = await call("/api/demo-login", {
          method: "POST",
          body: {
            role: "student",
            studentId,
            password: "test-management-password",
          },
        });
        assert.equal(r.status, 200, await r.clone().text());
        const cookie = r.headers.get("set-cookie").split(";")[0];
        const session = await (await call("/api/session", { cookie })).json();
        assert.equal(session.user.role, "student");
        assert.equal(session.user.studentId, studentId);
      },
    );

    await t.test("Студент не попадает в сотрудничьи разделы", async () => {
      const studentId = students.students[0].id;
      const r = await call("/api/demo-login", {
        method: "POST",
        body: {
          role: "student",
          studentId,
          password: "test-management-password",
        },
      });
      const cookie = r.headers.get("set-cookie").split(";")[0];
      assert.equal(
        (
          await call("/api/admin/overview?from=2026-09-01&to=2026-09-01", {
            cookie,
          })
        ).status,
        403,
      );
      assert.equal((await call("/api/daily", { cookie })).status, 403);
    });

    await t.test(
      "Отвязка учётной записи ВШЭ обрывает OIDC-сессию студента",
      async () => {
        // Провайдера OIDC в тестах нет, поэтому такую сессию кладём в базу
        // напрямую – ровно в том формате, что использует сервер.
        const student = students.students[1]; // привязан к "hse-12345"
        const rawToken = "test-oidc-token-" + Math.random().toString(36);
        const sessionId = createHash("sha256").update(rawToken).digest("hex");
        const db = new DatabaseSync(join(temp, "db.sqlite"));
        db.exec("PRAGMA busy_timeout=5000");
        db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(
          sessionId,
          JSON.stringify({
            user: {
              id: student.id,
              name: student.name,
              role: "student",
              studentId: student.id,
              source: "oidc",
              subject: "hse-12345",
            },
          }),
          Date.now() + 8 * 3600000,
        );
        db.close();
        const cookie = "journal=" + rawToken;

        const before = await (await call("/api/session", { cookie })).json();
        assert.equal(before.user?.role, "student");
        assert.equal(before.user?.studentId, student.id);

        const unlink = await call(
          "/api/admin/students/" + student.id + "/account",
          { method: "DELETE", cookie: admin },
        );
        assert.equal(unlink.status, 200, await unlink.clone().text());

        const after = await (await call("/api/session", { cookie })).json();
        assert.equal(after.user, null);
        assert.equal(
          (await call("/api/student/profile", { cookie })).status,
          401,
        );
      },
    );

    await t.test("Осиротевшая привязка не роняет сервер", async () => {
      const studentId = students.students[0].id;
      const r = await call("/api/demo-login", {
        method: "POST",
        body: {
          role: "student",
          studentId,
          password: "test-management-password",
        },
      });
      const cookie = r.headers.get("set-cookie").split(";")[0];
      // Со связанной учётной записью удаление запрещено – сначала отвязка.
      const unlink = await call(
        "/api/admin/students/" + studentId + "/account",
        {
          method: "DELETE",
          cookie: admin,
        },
      );
      assert.equal(unlink.status, 200);
      // Студента удаляют из реестра: сессия ссылается на несуществующую запись.
      const remove = await call("/api/admin/students/" + studentId, {
        method: "DELETE",
        cookie: admin,
      });
      assert.equal(remove.status, 200, await remove.clone().text());
      const after = await call("/api/student/profile", { cookie });
      assert.equal(after.status, 401, await after.clone().text());
    });
  } finally {
    child.kill("SIGTERM");
    await new Promise((r) => child.once("exit", r));
    rmSync(temp, { recursive: true, force: true });
  }
});
