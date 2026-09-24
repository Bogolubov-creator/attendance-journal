import test from "node:test";
import assert from "node:assert/strict";
import { startServer } from "./staff-server.js";

const PASSWORD = "длинный пароль преподавателя";
// fetch при чтении текста срезает BOM, поэтому он проверяется по байтам.
const parse = (bytes) => {
  assert.deepEqual(
    [...bytes.subarray(0, 3)],
    [0xef, 0xbb, 0xbf],
    "BOM для Excel",
  );
  return new TextDecoder()
    .decode(bytes)
    .split("\r\n")
    .map((line) => line.split(";").map((c) => c.replace(/^"|"$/g, "")));
};

test("Массовая выгрузка: сотрудники офиса и преподаватели со студентами без пароля, прежние коды гаснут", async () => {
  const s = await startServer(3124);
  try {
    const admin = await s.selectLogin("admin", "gadzhieva");
    const grant = async (id) =>
      (
        await s.call("/api/admin/access/" + id, {
          method: "POST",
          cookie: admin,
        })
      ).json();
    // t_test_1 уже с паролем и открытой сессией; t_test_2 – с неиспользованным кодом;
    // новый преподаватель без студентов в файл не попадает.
    const active = await grant("t_test_1");
    let r = await s.call("/api/first-login", {
      method: "POST",
      body: { login: active.login, code: active.code, password: PASSWORD },
    });
    const activeSession = s.cookieOf(r);
    const pending = await grant("t_test_2");
    const lonely = await (
      await s.call("/api/admin/teachers", {
        method: "POST",
        cookie: admin,
        body: { name: "Без Студентов Иванович" },
      })
    ).json();
    const lonelyInvite = await grant(lonely.id);

    const manager = await s.selectLogin("office", "akhmyatzhanov");
    const teacher = await s.selectLogin("teacher", "t_test_1");
    for (const cookie of [manager, teacher])
      assert.equal(
        (
          await s.call("/api/admin/access-export", {
            method: "POST",
            cookie,
          })
        ).status,
        403,
      );

    r = await s.call("/api/admin/access-export", {
      method: "POST",
      cookie: admin,
    });
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type"), /text\/csv/);
    assert.match(r.headers.get("content-disposition"), /attachment/);
    assert.match(r.headers.get("cache-control"), /no-store/);
    const [header, ...rows] = parse(new Uint8Array(await r.arrayBuffer()));
    assert.deepEqual(header, [
      "ФИО",
      "Роль",
      "Логин",
      "Код приглашения",
      "Действует до",
    ]);
    const names = rows.map((row) => row[0]);
    assert.equal(rows.length, 11, "10 сотрудников офиса + t_test_2");
    assert.ok(names.includes("Преподаватель Второй"));
    assert.ok(names.includes("Гаджиева Альбина Омаровна"));
    assert.ok(
      !names.includes("Преподаватель Первый"),
      "с паролем – не в файле",
    );
    assert.ok(!names.includes("Без Студентов Иванович"));
    const second = rows.find((row) => row[0] === "Преподаватель Второй");
    assert.equal(second[1], "Преподаватель");
    assert.equal(second[2], pending.login);
    assert.match(second[4], /^\d{2}\.\d{2}\.\d{4}$/);

    // Прежний код гаснет, новый действует; пароль и сессия t_test_1 не тронуты.
    const first = (code) =>
      s.call("/api/first-login", {
        method: "POST",
        body: { login: pending.login, code, password: PASSWORD },
      });
    assert.equal((await first(pending.code)).status, 403);
    // Поштучный код того, кто в файл не попал, тоже погашен.
    r = await s.call("/api/first-login", {
      method: "POST",
      body: {
        login: lonelyInvite.login,
        code: lonelyInvite.code,
        password: PASSWORD,
      },
    });
    assert.equal(r.status, 403);
    assert.equal((await first(second[3])).status, 200);
    assert.equal(
      (await s.call("/api/daily", { cookie: activeSession })).status,
      200,
    );
    r = await s.call("/api/login", {
      method: "POST",
      body: { login: active.login, password: PASSWORD },
    });
    assert.equal(r.status, 200);

    const db = s.db();
    const entry = db
      .prepare("SELECT * FROM audit WHERE action='access.export'")
      .get();
    db.close();
    assert.equal(entry.label, "кодов приглашения: 11");
    for (const row of rows) assert.ok(!JSON.stringify(entry).includes(row[3]));
  } finally {
    await s.close();
  }
});
