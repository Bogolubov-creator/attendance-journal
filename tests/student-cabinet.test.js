import { passwordHash } from "../src/management-auth.js";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const origin = "http://127.0.0.1:3114";
const temp = mkdtempSync(join(tmpdir(), "attendance-cabinet-"));
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
const demoLogin = async (studentId) => {
  const r = await call("/api/demo-login", {
    method: "POST",
    body: {
      role: "student",
      studentId,
      password: "test-management-password",
    },
  });
  assert.equal(r.status, 200, await r.clone().text());
  return r.headers.get("set-cookie").split(";")[0];
};

test("Кабинет студента", async (t) => {
  const child = spawn(process.execPath, ["src/server.js"], {
    env: {
      ...process.env,
      ROSTER_PATH: "tests/fixtures/roster.json",
      MANAGEMENT_PASSWORD_HASH: passwordHash("test-management-password"),
      DEMO_MODE: "true",
      AUTO_BACKUP: "false",
      DB_PATH: join(temp, "db.sqlite"),
      PORT: "3114",
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
    const studentId = "s_test_1";
    const otherStudentId = "s_test_2";
    const cookie = await demoLogin(studentId);

    await t.test("Студент видит свою карточку", async () => {
      const data = await (
        await call("/api/student/profile", { cookie })
      ).json();
      assert.equal(data.student.id, studentId);
      assert.deepEqual(data.editable, [
        "citizenship",
        "nameLatin",
        "sendingCountry",
        "arrivalDate",
        "residence",
        "passportUntil",
        "migrationCardUntil",
        "housing",
        "inRussia",
      ]);
    });

    await t.test(
      "Карточки ещё нет – кабинет всё равно открывается",
      async () => {
        const data = await (
          await call("/api/student/profile", { cookie })
        ).json();
        assert.equal(data.student.citizenship, "");
        assert.equal(data.student.version, 0);
      },
    );

    await t.test("Студент меняет свои поля", async () => {
      const r = await call("/api/student/profile", {
        method: "PUT",
        cookie,
        body: { citizenship: "Сербия", housing: "dormitory", version: 0 },
      });
      assert.equal(r.status, 200, await r.clone().text());
      const data = await (
        await call("/api/student/profile", { cookie })
      ).json();
      assert.equal(data.student.citizenship, "Сербия");
      assert.equal(data.student.housing, "dormitory");
    });

    await t.test("Некорректное значение отклоняется", async () => {
      const badHousing = await call("/api/student/profile", {
        method: "PUT",
        cookie,
        body: { housing: "Общежитие", version: 1 },
      });
      assert.equal(badHousing.status, 400);
      const badDate = await call("/api/student/profile", {
        method: "PUT",
        cookie,
        body: { passportUntil: "31.12.2026", version: 1 },
      });
      assert.equal(badDate.status, 400);
    });

    await t.test("Учебные поля из запроса студента игнорируются", async () => {
      await call("/api/student/profile", {
        method: "PUT",
        cookie,
        body: {
          program: "Юрист в бизнесе",
          year: 1,
          foreignStatus: "excluded",
          citizenship: "Китай",
          version: 1,
        },
      });
      const card = await (
        await call("/api/admin/students/" + studentId, { cookie: admin })
      ).json();
      assert.notEqual(card.student.program, "Юрист в бизнесе");
      assert.notEqual(card.student.foreignStatus, "excluded");
      assert.equal(card.student.citizenship, "Китай");
    });

    await t.test("Правка поверх чужой версии отклоняется", async () => {
      const r = await call("/api/student/profile", {
        method: "PUT",
        cookie,
        body: { citizenship: "Индия", version: 0 },
      });
      assert.equal(r.status, 409);
    });

    await t.test("Чужую карточку студент не откроет", async () => {
      const r = await call("/api/admin/students/" + otherStudentId, {
        cookie,
      });
      assert.equal(r.status, 403);
    });

    await t.test(
      "Чужой id в теле запроса не меняет чужую карточку",
      async () => {
        const otherCookie = await demoLogin(otherStudentId);
        const r = await call("/api/student/profile", {
          method: "PUT",
          cookie,
          body: {
            id: otherStudentId,
            studentId: otherStudentId,
            citizenship: "X",
            version: 2,
          },
        });
        assert.equal(r.status, 200, await r.clone().text());
        const own = await (
          await call("/api/student/profile", { cookie })
        ).json();
        assert.equal(own.student.id, studentId);
        assert.equal(own.student.citizenship, "X");
        const other = await (
          await call("/api/student/profile", { cookie: otherCookie })
        ).json();
        assert.equal(other.student.id, otherStudentId);
        assert.equal(other.student.citizenship, "");
      },
    );

    await t.test(
      "Одновременная правка: сотрудник сохраняет первым, устаревшая версия студента не перезаписывает его правку",
      async () => {
        const before = await (
          await call("/api/student/profile", { cookie })
        ).json();
        const staffEdit = await call(
          "/api/admin/students/" + studentId + "/profile",
          {
            method: "PUT",
            cookie: admin,
            body: {
              program: "",
              year: 0,
              foreignStatus: "unknown",
              enrollmentStatus: "active",
              citizenship: "Бразилия",
              version: before.student.version,
            },
          },
        );
        assert.equal(staffEdit.status, 200, await staffEdit.clone().text());
        const stale = await call("/api/student/profile", {
          method: "PUT",
          cookie,
          body: { citizenship: "Индия", version: before.student.version },
        });
        assert.equal(stale.status, 409);
        const card = await (
          await call("/api/admin/students/" + studentId, { cookie: admin })
        ).json();
        assert.equal(card.student.citizenship, "Бразилия");
      },
    );
  } finally {
    child.kill("SIGTERM");
    await new Promise((r) => child.once("exit", r));
    rmSync(temp, { recursive: true, force: true });
  }
});
