import { passwordHash } from "../src/management-auth.js";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  } finally {
    child.kill("SIGTERM");
    await new Promise((r) => child.once("exit", r));
    rmSync(temp, { recursive: true, force: true });
  }
});
