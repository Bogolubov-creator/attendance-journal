import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  writeFileSync,
  readFileSync,
  existsSync,
  statSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  runInstaller,
  buildEnv,
  validDomain,
} from "../scripts/installer/core.mjs";

// Папка журнала в миниатюре: шаблон .env и файлы, по которым установщик узнаёт папку.
function project() {
  const dir = mkdtempSync(path.join(tmpdir(), "installer-"));
  mkdirSync(path.join(dir, "src"));
  writeFileSync(path.join(dir, "src/server.js"), "");
  for (const f of [".env.example", "compose.yaml", "package.json"])
    copyFileSync(f, path.join(dir, f));
  return dir;
}
// Ответы по очереди; всё, что установщик напечатал, копится в out.
function fakeIo(answers) {
  const out = [];
  const queue = [...answers];
  return {
    out,
    io: {
      print: (t) => out.push(t),
      ask: async (p) => {
        out.push(p);
        if (!queue.length) throw Error("Кончились ответы на: " + p);
        return queue.shift();
      },
      askSecret: async (p) => {
        out.push(p);
        if (!queue.length) throw Error("Кончились ответы на: " + p);
        return queue.shift();
      },
    },
  };
}
// Команды не выполняются: записываются, код выхода – из fail.
function fakeExec(fail = {}) {
  const calls = [];
  const exec = async (cmd, args, opts = {}) => {
    const line = [cmd, ...args].join(" ");
    calls.push({ line, opts });
    const code =
      Object.entries(fail).find(([k]) => line.startsWith(k))?.[1] ?? 0;
    return {
      code,
      stdout: line.includes("logs")
        ? "строка журнала сервера"
        : line.includes("invite-admin")
          ? "Логин: gadzhieva.ao\nКод приглашения: ABCD-EFGH-JKMN"
          : "",
      stderr: code ? "сбой" : "",
    };
  };
  return { calls, exec };
}
const netOk = { portFree: async () => true, get: async () => 200 };
const ctx = (dir, io, exec, extra = {}) => ({
  io,
  exec,
  net: netOk,
  cwd: dir,
  platform: "linux",
  user: "admin",
  sleep: async () => {},
  preset: {},
  ...extra,
});
// Ответы новой установки через Docker со встроенным Caddy (всё по умолчанию, кроме домена).
// Порядок: куда, как, домен, HTTPS, три папки, копии, вход, «Установить?», кому код.
const dockerCaddy = [
  "",
  "",
  "journal.example.edu",
  "",
  "",
  "",
  "",
  "",
  "",
  "д",
  "",
];

test("Домен: формат проверяется", () => {
  assert.ok(validDomain("journal.pravo.hse.ru"));
  for (const bad of ["localhost", "a b.ru", "-x.ru", "x.ru/"])
    assert.ok(!validDomain(bad), bad);
});

test("Значение с переводом строки не попадает в .env", () => {
  assert.throws(() => buildEnv("A=1\n", { A: "x\ny" }), /перевод строки/);
  assert.equal(buildEnv("A=1\nB=2\n", { B: "3", C: "4" }), "A=1\nB=3\nC=4\n");
});

test("Через Docker со встроенным Caddy: .env, права, папки и порядок команд", async () => {
  const dir = project();
  try {
    const { io, out } = fakeIo(dockerCaddy);
    const { exec, calls } = fakeExec();
    assert.equal(await runInstaller(ctx(dir, io, exec)), 0);
    const env = readFileSync(path.join(dir, ".env"), "utf8");
    for (const line of [
      "DOMAIN=journal.example.edu",
      "APP_ORIGIN=https://journal.example.edu",
      "DEMO_MODE=false",
      "DATA_MODE=live",
      "TRUST_PROXY=1",
      "BACKUP_KEEP=14",
      "DATA_DIR=data",
      "BACKUPS_DIR=backups",
      "UPLOADS_DIR=uploads",
      "PROXY_SCALE=1",
    ])
      assert.ok(env.split("\n").includes(line), line);
    assert.equal(statSync(path.join(dir, ".env")).mode & 0o777, 0o600);
    for (const d of ["data", "backups", "uploads"])
      assert.equal(statSync(path.join(dir, d)).mode & 0o777, 0o700);
    const lines = calls.map((c) => c.line);
    const order = [
      "docker info",
      "sudo chown",
      "docker compose config",
      "docker compose up -d --build",
    ];
    let at = -1;
    for (const cmd of order) {
      const i = lines.findIndex((l, n) => n > at && l.startsWith(cmd));
      assert.ok(i > at, "порядок: " + cmd + " в " + lines.join(" | "));
      at = i;
    }
    assert.ok(
      out.join("\n").includes("Сайт открывается: https://journal.example.edu"),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Свой прокси: Caddy выключен, TRUST_PROXY спрошен, предупреждение про Host, порты не проверяются", async () => {
  const dir = project();
  const dataDir = path.join(mkdtempSync(path.join(tmpdir(), "disk-")), "data");
  try {
    const { io, out } = fakeIo([
      "",
      "",
      "journal.example.edu",
      "2",
      "2",
      dataDir,
      "",
      "",
      "30",
      "",
      "д",
      "",
    ]);
    const { exec } = fakeExec();
    let portChecks = 0;
    const net = { ...netOk, portFree: async () => (portChecks++, false) };
    assert.equal(await runInstaller(ctx(dir, io, exec, { net })), 0);
    const env = readFileSync(path.join(dir, ".env"), "utf8");
    assert.ok(env.includes("PROXY_SCALE=0"));
    assert.ok(env.includes("TRUST_PROXY=2"));
    assert.ok(env.includes("DATA_DIR=" + dataDir));
    assert.ok(existsSync(dataDir), "папка на другом диске создана");
    assert.ok(env.includes("BACKUP_KEEP=30"));
    assert.match(out.join("\n"), /заголовок Host без изменений/);
    assert.equal(portChecks, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("«<» возвращает к предыдущему вопросу, неверный ответ переспрашивается", async () => {
  const dir = project();
  try {
    // домен с ошибкой → переспрос; затем на вопросе HTTPS «<» и новый домен.
    const answers = [
      "",
      "",
      "не домен",
      "old.example.edu",
      "<",
      "new.example.edu",
      "",
      "",
      "",
      "",
      "",
      "",
      "д",
      "",
    ];
    const { io, out } = fakeIo(answers);
    assert.equal(await runInstaller(ctx(dir, io, fakeExec().exec)), 0);
    assert.ok(out.includes("Это не похоже на доменное имя"));
    assert.ok(
      readFileSync(path.join(dir, ".env"), "utf8").includes(
        "DOMAIN=new.example.edu",
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Проверки до изменений: нет Docker, занят порт, не та папка – остановка без .env", async () => {
  for (const [name, extra, fail] of [
    ["нет Docker", {}, { "docker --version": 127 }],
    ["Docker не запущен", {}, { "docker info": 1 }],
    [
      "порт 443 занят",
      { net: { ...netOk, portFree: async (p) => p !== 443 } },
      {},
    ],
  ]) {
    const dir = project();
    try {
      const { io, out } = fakeIo(dockerCaddy);
      const code = await runInstaller(ctx(dir, io, fakeExec(fail).exec, extra));
      assert.equal(code, 1, name);
      assert.ok(!existsSync(path.join(dir, ".env")), name + ": .env не создан");
      assert.match(out.join("\n"), /Ошибка:/, name);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const empty = mkdtempSync(path.join(tmpdir(), "installer-"));
  const { io, out } = fakeIo([]);
  assert.equal(await runInstaller(ctx(empty, io, fakeExec().exec)), 1);
  assert.match(out.join("\n"), /из папки журнала/);
  rmSync(empty, { recursive: true, force: true });
});

test("Журнал не ответил: последние строки журнала, данные и .env на месте, ошибка", async () => {
  const dir = project();
  try {
    const { io, out } = fakeIo(dockerCaddy);
    const { exec, calls } = fakeExec();
    const net = { ...netOk, get: async () => 0 };
    assert.equal(await runInstaller(ctx(dir, io, exec, { net })), 1);
    assert.ok(out.includes("строка журнала сервера"));
    assert.ok(existsSync(path.join(dir, ".env")));
    assert.ok(
      !calls.some((c) => /\b(down|rm)\b/.test(c.line)),
      "ничего не удаляется",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("HTTPS не отвечает: предупреждение, установка успешна", async () => {
  const dir = project();
  try {
    const { io, out } = fakeIo(dockerCaddy);
    const net = {
      ...netOk,
      get: async (url) => (url.startsWith("https:") ? 0 : 200),
    };
    assert.equal(await runInstaller(ctx(dir, io, fakeExec().exec, { net })), 0);
    assert.match(out.join("\n"), /пока не отвечает/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Отказ на «Установить?» ничего не меняет", async () => {
  const dir = project();
  try {
    const answers = [...dockerCaddy.slice(0, -2), "н"];
    const { io } = fakeIo(answers);
    const { exec, calls } = fakeExec();
    assert.equal(await runInstaller(ctx(dir, io, exec)), 0);
    assert.ok(!existsSync(path.join(dir, ".env")));
    assert.ok(!calls.some((c) => c.line.includes("compose up")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Windows: права на .env и папки через icacls", async () => {
  const dir = project();
  try {
    const { io } = fakeIo(dockerCaddy);
    const { exec, calls } = fakeExec();
    assert.equal(
      await runInstaller(ctx(dir, io, exec, { platform: "win32" })),
      0,
    );
    const icacls = calls.filter((c) => c.line.startsWith("icacls"));
    assert.equal(icacls.length, 4, ".env и три папки");
    assert.ok(!calls.some((c) => c.line.startsWith("sudo")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Личные пароли по умолчанию: режим включается, общий пароль не спрашивается, первый код и памятка", async () => {
  const dir = project();
  try {
    const { io, out } = fakeIo(dockerCaddy);
    const { exec, calls } = fakeExec();
    assert.equal(await runInstaller(ctx(dir, io, exec)), 0);
    const lines = calls.map((c) => c.line);
    const enable = lines.findIndex((l) =>
      l.endsWith("scripts/enable-personal-only.mjs"),
    );
    const invite = lines.findIndex((l) =>
      l.endsWith("scripts/invite-admin.mjs gadzhieva"),
    );
    assert.ok(enable > 0 && invite > enable, lines.join(" | "));
    assert.ok(lines[enable].startsWith("docker compose exec -T app node"));
    assert.ok(
      !out.some((t) => /не отображается/.test(t)),
      "пароль не спрашивался",
    );
    assert.match(
      readFileSync(path.join(dir, ".env"), "utf8"),
      /^MANAGEMENT_PASSWORD_HASH=$/m,
    );
    const text = out.join("\n");
    assert.match(text, /Кому выдать первый код/);
    assert.match(text, /Гаджиева Альбина Омаровна/);
    assert.match(text, /Код приглашения: ABCD-EFGH-JKMN/);
    for (const hint of [
      "Обновить реестр из Excel",
      "Выгрузить коды приглашения",
      "выгружайте обе папки",
      "docker compose logs",
      "Обновление:",
    ])
      assert.ok(text.includes(hint), hint);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Только общий пароль: предупреждение, повтор при несовпадении, в .env только хеш, пароля нет ни в командах, ни на экране", async () => {
  const dir = project();
  try {
    const secret = "общий пароль журнала";
    // …копии, вход «2», пароль, неверный повтор, пароль, повтор, «Установить?», кому код – второй.
    const answers = [
      ...dockerCaddy.slice(0, 8),
      "2",
      secret,
      "другой пароль",
      secret,
      secret,
      "д",
      "2",
    ];
    const { io, out } = fakeIo(answers);
    const { exec, calls } = fakeExec();
    assert.equal(await runInstaller(ctx(dir, io, exec)), 0);
    const text = out.join("\n");
    assert.match(text, /не подтверждает, кто вошёл/);
    assert.match(text, /Пароли не совпадают/);
    const env = readFileSync(path.join(dir, ".env"), "utf8");
    assert.match(env, /^MANAGEMENT_PASSWORD_HASH=[a-f0-9]{32}:[a-f0-9]{128}$/m);
    assert.ok(!env.includes(secret));
    assert.ok(!calls.some((c) => c.line.includes(secret)));
    assert.ok(!out.some((t) => t.includes(secret)));
    assert.ok(!calls.some((c) => c.line.includes("enable-personal-only")));
    assert.ok(calls.some((c) => c.line.endsWith("invite-admin.mjs chinkova")));
    assert.match(text, /ограничьте доступ к сайту/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
