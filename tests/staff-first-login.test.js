import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { startServer } from "./staff-server.js";
import { makeLogin, passwordProblem } from "../src/staff-accounts.js";

test("Логин: фамилия и инициалы латиницей, без «Вак_», цифра при совпадении", () => {
  const none = () => false;
  assert.equal(makeLogin("Иванов Иван Иванович", none), "ivanov.ii");
  assert.equal(makeLogin("Вак_Иванов Иван Иванович", none), "ivanov.ii");
  assert.equal(makeLogin("Щукина Ёлка", none), "shhukina.e");
  assert.equal(makeLogin("Цой", none), "coj");
  const taken = new Set(["ivanov.ii", "ivanov.ii2"]);
  assert.equal(
    makeLogin("Иванов Илья Игоревич", (l) => taken.has(l)),
    "ivanov.ii3",
  );
});

test("Пароль: не короче 10 символов и не из распространённых", () => {
  assert.match(passwordProblem("короткий"), /не короче 10/);
  assert.match(passwordProblem("Qwertyuiop"), /распространён/);
  assert.match(passwordProblem("1234567890"), /распространён/);
  for (const common of [
    "password2026",
    "1q2w3e4r5t",
    "йцукенгшщз",
    "zhurnal2026",
  ])
    assert.match(passwordProblem(common), /распространён/, common);
  assert.equal(passwordProblem("зелёный кит в тумане"), null);
});

test("Скрипт кода отказывает без ID полного доступа", async () => {
  const s = await startServer(3121);
  try {
    for (const id of [undefined, "nobody", "akhmyatzhanov"]) {
      assert.throws(
        () =>
          execFileSync(
            process.execPath,
            ["scripts/invite-admin.mjs", ...(id ? [id] : [])],
            {
              env: { ...process.env, DB_PATH: s.dbPath },
              stdio: "pipe",
            },
          ),
        undefined,
        String(id),
      );
    }
  } finally {
    await s.close();
  }
});

test("Первый вход администратора по коду со скрипта: пароль задан, код погашен, всё только хешами", async () => {
  const s = await startServer(3121);
  try {
    const { login, code } = s.inviteAdmin("gadzhieva");
    assert.equal(login, "gadzhieva.ao");
    assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const first = (body) =>
      s.call("/api/first-login", { method: "POST", body });
    const password = "зелёный кит в тумане";

    let r = await first({ login, code: "AAAA-BBBB-CCCC", password });
    assert.equal(r.status, 403);
    assert.match((await r.json()).error, /Код не подходит или истёк/);

    r = await first({ login, code, password: "коротко" });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /не короче 10/);
    r = await first({ login, code, password: "password123" });
    assert.equal(r.status, 400);

    // Код без дефисов и в нижнем регистре тоже принимается.
    r = await first({
      login: "Gadzhieva.AO",
      code: code.replace(/-/g, "").toLowerCase(),
      password,
    });
    assert.equal(r.status, 200, await r.clone().text());
    const { user } = await r.json();
    assert.equal(user.role, "admin");
    assert.equal(user.name, "Гаджиева Альбина Омаровна");
    const cookie = s.cookieOf(r);
    const session = await (await s.call("/api/session", { cookie })).json();
    assert.equal(session.user.source, "personal");
    assert.equal((await s.call("/api/admin/overview", { cookie })).status, 200);

    // Использованный код больше не принимается.
    r = await first({ login, code, password: "другой пароль журнала" });
    assert.equal(r.status, 403);

    // В базе и журнале нет ни пароля, ни кода в открытом виде.
    const db = s.db();
    const dump = JSON.stringify([
      db.prepare("SELECT * FROM staff_accounts").all(),
      db.prepare("SELECT * FROM audit").all(),
      db.prepare("SELECT * FROM sessions").all(),
    ]);
    for (const secret of [password, code, code.replace(/-/g, "")])
      assert.ok(!dump.includes(secret), "в базе найден " + secret);
    const entry = db
      .prepare("SELECT * FROM audit WHERE action='access.first-login'")
      .get();
    assert.equal(entry.actor, "Гаджиева Альбина Омаровна");

    // Смена версии пароля в базе закрывает сессию при следующем запросе.
    db.prepare(
      "UPDATE staff_accounts SET passwordVersion=passwordVersion+1",
    ).run();
    db.close();
    assert.equal((await s.call("/api/admin/overview", { cookie })).status, 401);
  } finally {
    await s.close();
  }
});

test("Истёкший код не принимается, новый код заменяет прежний", async () => {
  const s = await startServer(3121);
  try {
    const first = s.inviteAdmin("chinkova");
    const db = s.db();
    db.prepare("UPDATE staff_accounts SET inviteExpires=?").run(Date.now() - 1);
    db.close();
    const body = {
      login: first.login,
      code: first.code,
      password: "длинный пароль журнала",
    };
    let r = await s.call("/api/first-login", { method: "POST", body });
    assert.equal(r.status, 403);

    const second = s.inviteAdmin("chinkova");
    assert.equal(second.login, first.login);
    r = await s.call("/api/first-login", {
      method: "POST",
      body: { ...body, code: first.code },
    });
    assert.equal(r.status, 403, "прежний код погашен новым");
    r = await s.call("/api/first-login", {
      method: "POST",
      body: { ...body, code: second.code },
    });
    assert.equal(r.status, 200);
  } finally {
    await s.close();
  }
});

test("Код приглашения хранится хешем scrypt с собственной солью", async () => {
  const s = await startServer(3121);
  try {
    const first = s.inviteAdmin("chinkova");
    const second = s.inviteAdmin("gadzhieva");
    const db = s.db();
    const hashes = db
      .prepare("SELECT inviteHash FROM staff_accounts")
      .all()
      .map((r) => r.inviteHash);
    // Коду со старым хешем SHA-256 журнал не верит – такие коды выдаются заново.
    db.prepare(
      "UPDATE staff_accounts SET inviteHash=? WHERE personId='gadzhieva'",
    ).run("a".repeat(64));
    db.close();
    for (const h of hashes)
      assert.match(h, /^s1024:[a-f0-9]{32}:[a-f0-9]{64}$/);
    assert.notEqual(hashes[0].split(":")[1], hashes[1].split(":")[1]);
    const redeem = (invite) =>
      s.call("/api/first-login", {
        method: "POST",
        body: {
          login: invite.login,
          code: invite.code,
          password: "длинный пароль журнала",
        },
      });
    assert.equal((await redeem(first)).status, 200);
    assert.equal((await redeem(second)).status, 403);
  } finally {
    await s.close();
  }
});

test("Неверные коды приглашения не закрывают ни первый вход, ни вход по паролю", async () => {
  const s = await startServer(3121);
  try {
    const invite = s.inviteAdmin("chinkova");
    const first = (code, password = "длинный пароль журнала") =>
      s.call("/api/first-login", {
        method: "POST",
        body: { login: invite.login, code, password },
      });
    for (let i = 0; i < 6; i++)
      assert.equal((await first("AAAA-BBBB-CCC" + (i + 2))).status, 403);
    assert.equal((await first(invite.code)).status, 200);
    // У активной учётной записи ложные коды тоже не блокируют вход по паролю.
    for (let i = 0; i < 6; i++) await first("AAAA-BBBB-CCC" + (i + 2));
    const r = await s.call("/api/login", {
      method: "POST",
      body: { login: invite.login, password: "длинный пароль журнала" },
    });
    assert.equal(r.status, 200);
  } finally {
    await s.close();
  }
});
