import { passwordHash } from "../src/management-auth.js";
import test from "node:test";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
const origin = "http://127.0.0.1:3101",
  roster = JSON.parse(readFileSync("tests/fixtures/roster.json"));
const temp = mkdtempSync(join(tmpdir(), "attendance-api-test-")),
  path = join(temp, "test.sqlite");
let child, cookie;
async function request(
  route,
  method = "GET",
  body,
  auth = cookie,
  source = origin,
) {
  return fetch(origin + route, {
    method,
    headers: {
      origin: source,
      "content-type": "application/json",
      ...(auth ? { cookie: auth } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
test("API: изоляция, сохранение, редактирование и админка", async (t) => {
  child = spawn(process.execPath, ["src/server.js"], {
    env: {
      ...process.env,
      ROSTER_PATH: "tests/fixtures/roster.json",
      MANAGEMENT_PASSWORD_HASH: passwordHash("test-management-password"),
      DEMO_MODE: "true",
      AUTO_BACKUP: "true",
      BACKUP_DIR: join(temp, "backups"),
      DB_PATH: path,
      PORT: "3101",
      APP_ORIGIN: origin,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    child.stdout.once("data", resolve);
    child.once("error", reject);
    child.once("exit", (c) => reject(Error("server exit " + c)));
  });
  try {
    const e = roster.enrollments[0],
      db = new DatabaseSync(path);
    // Сервер при запуске делает первую резервную копию и держит блокировку; ждём её, как ждёт сам сервер.
    db.exec("PRAGMA busy_timeout=5000");
    const lesson = {
      id: "test_past",
      teacherId: e.teacherId,
      course: e.course,
      groups: [e.group],
      date: "2026-09-01",
      start: "09:00",
      end: "10:00",
      source: "test",
    };
    // Историческая отметка прежнего журнала по парам: новые так не создаются.
    db.prepare("INSERT INTO lessons VALUES(?,?,?)").run(
      lesson.id,
      lesson.teacherId,
      JSON.stringify(lesson),
    );
    db.prepare("INSERT INTO marks VALUES(?,?,?,?,?)").run(
      lesson.id,
      e.studentId,
      "present",
      "",
      new Date().toISOString(),
    );
    db.close();
    await t.test(
      "Резервная копия автоматически создаётся и открывается",
      async () => {
        let files = [];
        for (let i = 0; i < 30; i++) {
          files = readdirSync(join(temp, "backups")).filter((f) =>
            f.endsWith(".sqlite"),
          );
          if (files.length) break;
          await new Promise((r) => setTimeout(r, 50));
        }
        assert.equal(files.length, 1);
        // Файл появляется раньше, чем копирование завершено: ждём снятия блокировки.
        let check;
        for (let i = 0; i < 100 && !check; i++) {
          const copy = new DatabaseSync(join(temp, "backups", files[0]));
          try {
            check = copy.prepare("PRAGMA integrity_check").get();
          } catch (e) {
            if (e.errcode !== 5) throw e;
            await new Promise((r) => setTimeout(r, 50));
          } finally {
            copy.close();
          }
        }
        assert.equal(check?.integrity_check, "ok");
      },
    );
    await t.test("Без входа API закрыт; файлы базы не отдаются", async () => {
      assert.equal(
        (await request("/api/daily", "GET", null, null)).status,
        401,
      );
      assert.equal(
        (await request("/data/roster.json", "GET", null, null)).status,
        404,
      );
    });
    await t.test("Другая origin не может войти", async () =>
      assert.equal(
        (
          await request(
            "/api/demo-login",
            "POST",
            {
              role: "teacher",
              teacherId: e.teacherId,
              password: "test-management-password",
            },
            null,
            "https://evil.example",
          )
        ).status,
        403,
      ),
    );
    const login = await request(
      "/api/demo-login",
      "POST",
      {
        role: "teacher",
        teacherId: e.teacherId,
        password: "test-management-password",
      },
      null,
    );
    cookie = login.headers.get("set-cookie").split(";")[0];
    await t.test("Учитель не видит админку", async () => {
      assert.equal((await request("/api/admin/overview")).status, 403);
      assert.equal(
        (await request("/api/admin/students/" + e.studentId)).status,
        403,
      );
    });
    await t.test("Адреса журнала по парам и РУЗ сняты", async () => {
      assert.equal((await request("/api/lessons")).status, 404);
      assert.equal((await request("/api/ruz/sync", "POST", {})).status, 404);
      assert.equal((await request("/api/admin/automation")).status, 403);
    });
    await t.test(
      "Восемь учебных дней проходят через API и собираются в дашборде",
      async () => {
        for (let day = 2; day <= 9; day++)
          assert.equal(
            (
              await request("/api/daily", "PUT", {
                date: "2026-09-0" + day,
                course: e.course,
                version: 0,
                marks: [{ studentId: e.studentId, status: "absent" }],
              })
            ).status,
            200,
          );
      },
    );
    const login2 = await request("/api/demo-login", "POST", {
      role: "admin",
      password: "test-management-password",
    });
    const teacherCookie = cookie;
    cookie = login2.headers.get("set-cookie").split(";")[0];
    await t.test("Старая сессия отозвана при смене входа", async () =>
      assert.equal(
        (await request("/api/daily", "GET", null, teacherCookie)).status,
        401,
      ),
    );
    await t.test("Админ видит историю и архив задолженностей", async () => {
      const overview = await request("/api/admin/overview");
      assert.equal(overview.status, 200);
      // В обзоре – только число занятий; сам список отдаёт маршрут одного студента.
      const listedRow = (await overview.json()).students.find(
        (s) => s.id === e.studentId,
      );
      assert.equal("records" in listedRow, false);
      // Из менеджера обзору нужны только id и имя, группы интерфейс реестра не читает.
      for (const s of (await (await request("/api/admin/overview")).json())
        .students) {
        assert.equal("groups" in s, false);
        if (s.manager !== null)
          assert.deepEqual(Object.keys(s.manager).sort(), ["id", "name"]);
      }
      const card = await (
        await request("/api/admin/students/" + e.studentId)
      ).json();
      assert.equal(listedRow.recordCount, card.records.length);
      // В карточке – все занятия: дата, дисциплина, преподаватель, отметка; новые сверху.
      const listed = card.records;
      assert.deepEqual(listed[0], {
        date: "2026-09-09",
        course: e.course,
        teacher: roster.teachers.find((x) => x.id === e.teacherId).name,
        status: "absent",
      });
      assert.ok(listed.length >= 8);
      assert.ok(listed.every((r, i) => !i || listed[i - 1].date >= r.date));
      // Задолженности – архив прежней версии: новые не создаются, старые видны.
      const archive = new DatabaseSync(path);
      archive.exec("PRAGMA busy_timeout=5000");
      archive
        .prepare("INSERT INTO debts VALUES(?,?,?,0,?)")
        .run(
          "archive_debt",
          e.studentId,
          "Тестовая работа",
          "2026-09-01T00:00:00Z",
        );
      archive.close();
      let s = await (
        await request("/api/admin/students/" + e.studentId)
      ).json();
      assert.equal(s.student.debtCount, 1);
      assert.deepEqual(
        s.debts.map((d) => [d.title, d.resolved]),
        [["Тестовая работа", 0]],
      );
      assert.equal(s.records.length, 9);
      assert.equal(s.student.lastVisit, "2026-09-01");
      assert.equal(s.student.days, 8);
      assert.equal(s.student.absenceAlert, true);
      assert.equal(s.student.attention, true);
      const name = roster.students.find((x) => x.id === e.studentId).name;
      const row = (await (await request("/api/admin/export")).text())
        .split("\r\n")
        .find((line) => line.startsWith('"' + name + '"'))
        .split(";");
      assert.equal(row[4], '"1"');
      assert.equal(
        (
          await request("/api/admin/debts", "POST", {
            studentId: e.studentId,
            title: "Новая работа",
          })
        ).status,
        404,
      );
      assert.equal(
        (
          await request("/api/admin/debts/archive_debt", "PATCH", {
            resolved: true,
          })
        ).status,
        404,
      );
      s = await (await request("/api/admin/students/" + e.studentId)).json();
      assert.equal(s.debts.length, 1);
      assert.equal(s.student.debtCount, 1);
    });
    await t.test("CSV доступен администратору", async () => {
      const r = await request("/api/admin/export");
      assert.equal(r.status, 200);
      assert.match(await r.text(), /Студент/);
    });
    await t.test("Сессия не отдаёт неиспользуемых полей", async () => {
      const session = await (await request("/api/session")).json();
      assert.equal("oidcReady" in session, false);
      assert.equal("demoTeachers" in session, false);
    });
    await t.test("Выход отзывает сессию", async () => {
      await request("/api/logout", "POST", {});
      assert.equal((await request("/api/admin/overview")).status, 401);
    });
  } finally {
    child.kill();
    await new Promise((r) => child.once("exit", r));
    rmSync(temp, { recursive: true, force: true });
  }
});
