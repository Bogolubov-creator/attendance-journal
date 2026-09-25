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
  readdirSync,
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

// Без Docker: домен, HTTPS (только свой прокси), TRUST_PROXY, три папки, копии, вход, «Установить?», кому код.
const nativeAnswers = [
  "journal.example.edu",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "д",
  "",
];
const nativeCtx = (dir, io, exec, extra = {}) =>
  ctx(dir, io, exec, {
    preset: { target: "local", method: "native" },
    nodePath: "/usr/bin/node",
    isRoot: false,
    ...extra,
  });

test("Linux без Docker: npm ci, служба systemd с папками данных, запуск, код через node с DB_PATH", async () => {
  const dir = project();
  try {
    const { io, out } = fakeIo(nativeAnswers);
    const { exec, calls } = fakeExec();
    assert.equal(await runInstaller(nativeCtx(dir, io, exec)), 0);
    const env = readFileSync(path.join(dir, ".env"), "utf8");
    for (const line of [
      "HOST=127.0.0.1",
      "PORT=3100",
      "DB_PATH=data/attendance.sqlite",
      "BACKUP_DIR=data/backups",
      "UPLOAD_DIR=data/uploads",
    ])
      assert.ok(env.split("\n").includes(line), line);
    assert.ok(!env.includes("PROXY_SCALE"), "переменные Docker не нужны");
    const lines = calls.map((c) => c.line);
    const order = [
      "systemctl --version",
      "npm ci --omit=dev",
      "sudo tee /etc/systemd/system/attendance-journal.service",
      "sudo systemctl daemon-reload",
      "sudo systemctl enable attendance-journal",
      "sudo systemctl restart attendance-journal",
      "/usr/bin/node scripts/enable-personal-only.mjs",
      "/usr/bin/node scripts/invite-admin.mjs gadzhieva",
    ];
    let at = -1;
    for (const cmd of order) {
      const i = lines.findIndex((l, n) => n > at && l.startsWith(cmd));
      assert.ok(i > at, "порядок: " + cmd + " в " + lines.join(" | "));
      at = i;
    }
    const unit = calls.find((c) => c.line.startsWith("sudo tee")).opts.input;
    assert.match(
      unit,
      /ExecStart="\/usr\/bin\/node" "--env-file=.+\/\.env" src\/server\.js/,
    );
    for (const d of ["data", "data/backups", "data/uploads"])
      assert.ok(unit.includes(`ReadWritePaths="${path.join(dir, d)}"`), d);
    const invite = calls.find((c) => c.line.includes("invite-admin"));
    assert.deepEqual(invite.opts.env, { DB_PATH: "data/attendance.sqlite" });
    assert.match(out.join("\n"), /journalctl -u attendance-journal/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Linux без Docker: от root и без systemd – отказ до изменений", async () => {
  for (const [name, extra, fail] of [
    ["root", { isRoot: true }, {}],
    ["нет systemd", {}, { "systemctl --version": 127 }],
  ]) {
    const dir = project();
    try {
      const { io, out } = fakeIo(nativeAnswers);
      assert.equal(
        await runInstaller(nativeCtx(dir, io, fakeExec(fail).exec, extra)),
        1,
        name,
      );
      assert.ok(!existsSync(path.join(dir, ".env")), name);
      assert.match(out.join("\n"), /Ошибка:/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("Windows без Docker: права администратора, npm.cmd, задача планировщика от SYSTEM, icacls", async () => {
  const dir = project();
  try {
    const { io } = fakeIo(nativeAnswers);
    const { exec, calls } = fakeExec();
    assert.equal(
      await runInstaller(
        nativeCtx(dir, io, exec, {
          platform: "win32",
          nodePath: "C:\\node\\node.exe",
        }),
      ),
      0,
    );
    const lines = calls.map((c) => c.line);
    assert.ok(
      lines[0].startsWith("net session"),
      "сначала проверка прав администратора",
    );
    assert.ok(lines.some((l) => l.startsWith("npm.cmd ci --omit=dev")));
    const ps = calls.find((c) => c.line.startsWith("powershell.exe"));
    assert.ok(ps, "задача регистрируется через PowerShell");
    assert.match(
      ps.line,
      /Register-ScheduledTask -TaskName 'AttendanceJournal'/,
    );
    assert.match(ps.line, /-UserId 'SYSTEM'/);
    assert.ok(lines.filter((l) => l.startsWith("icacls")).length >= 4);
    assert.ok(!lines.some((l) => l.startsWith("sudo")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const dir2 = project();
  try {
    const { io, out } = fakeIo(nativeAnswers);
    assert.equal(
      await runInstaller(
        nativeCtx(dir2, io, fakeExec({ "net session": 2 }).exec, {
          platform: "win32",
        }),
      ),
      1,
    );
    assert.match(out.join("\n"), /от имени администратора/);
  } finally {
    rmSync(dir2, { recursive: true, force: true });
  }
});

test("macOS без Docker – понятный отказ", async () => {
  const dir = project();
  try {
    const { io, out } = fakeIo(nativeAnswers);
    assert.equal(
      await runInstaller(
        nativeCtx(dir, io, fakeExec().exec, { platform: "darwin" }),
      ),
      1,
    );
    assert.match(
      out.join("\n"),
      /На macOS журнал ставится только через Docker/,
    );
    assert.ok(!existsSync(path.join(dir, ".env")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Прежняя установка через Docker: .env с настройками и база с отметками.
function installedDocker() {
  const dir = project();
  writeFileSync(
    path.join(dir, ".env"),
    "DOMAIN=journal.example.edu\nAPP_ORIGIN=https://journal.example.edu\nDATA_DIR=data\nPROXY_SCALE=1\nSECRET_MARK=1\n",
  );
  mkdirSync(path.join(dir, "data"));
  writeFileSync(path.join(dir, "data/attendance.sqlite"), "база");
  mkdirSync(path.join(dir, "uploads"));
  writeFileSync(path.join(dir, "uploads/scan.pdf"), "скан");
  return dir;
}

test("Прежняя установка: «Выйти» ничего не меняет", async () => {
  const dir = installedDocker();
  try {
    const before = readFileSync(path.join(dir, ".env"), "utf8");
    const { io, out } = fakeIo(["", ""]);
    const { exec, calls } = fakeExec();
    assert.equal(await runInstaller(ctx(dir, io, exec)), 0);
    assert.match(out.join("\n"), /уже установлен журнал/);
    assert.ok(
      !out.some((t) => /Адрес сайта/.test(t)),
      "вопросов новой установки нет",
    );
    assert.equal(readFileSync(path.join(dir, ".env"), "utf8"), before);
    assert.ok(!calls.some((c) => c.line.startsWith("docker compose")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Прежняя установка через Docker: «Обновить» – остановка, копия базы, пересборка; настройки и данные не тронуты", async () => {
  const dir = installedDocker();
  try {
    const before = readFileSync(path.join(dir, ".env"), "utf8");
    // куда – этот компьютер, «1» – обновить (Enter значит «Выйти»), как установлен – по умолчанию (Docker по .env)
    const { io, out } = fakeIo(["", "1", ""]);
    const { exec, calls } = fakeExec();
    assert.equal(await runInstaller(ctx(dir, io, exec)), 0);
    const lines = calls.map((c) => c.line);
    const stop = lines.indexOf("docker compose stop app");
    const up = lines.indexOf("docker compose up -d --build");
    assert.ok(stop >= 0 && up > stop, lines.join(" | "));
    const copies = readdirSync(path.join(dir, "data")).filter((f) =>
      f.includes("before-update"),
    );
    assert.equal(copies.length, 1);
    assert.equal(
      readFileSync(path.join(dir, "data", copies[0]), "utf8"),
      "база",
    );
    assert.equal(readFileSync(path.join(dir, ".env"), "utf8"), before);
    assert.equal(
      readFileSync(path.join(dir, "uploads/scan.pdf"), "utf8"),
      "скан",
    );
    assert.ok(
      !lines.some((l) => /enable-personal-only|invite-admin/.test(l)),
      "режим входа не меняется",
    );
    assert.match(out.join("\n"), /Обновление готово/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Прежняя установка без Docker: Linux – systemctl stop/start и npm ci; Windows – задача планировщика", async () => {
  for (const [platform, stopCmd, startCmd, npm] of [
    [
      "linux",
      "sudo systemctl stop attendance-journal",
      "sudo systemctl start attendance-journal",
      "npm ci",
    ],
    [
      "win32",
      "powershell.exe -NoProfile -Command Stop-ScheduledTask",
      "powershell.exe -NoProfile -Command Start-ScheduledTask",
      "npm.cmd ci",
    ],
  ]) {
    const dir = project();
    try {
      writeFileSync(
        path.join(dir, ".env"),
        "DOMAIN=journal.example.edu\nHOST=127.0.0.1\nDB_PATH=data/attendance.sqlite\n",
      );
      mkdirSync(path.join(dir, "data"));
      writeFileSync(path.join(dir, "data/attendance.sqlite"), "база");
      const { io } = fakeIo([]);
      const { exec, calls } = fakeExec();
      const c = ctx(dir, io, exec, {
        platform,
        preset: { update: true, target: "local", method: "native" },
        nodePath: "node",
        isRoot: false,
      });
      assert.equal(await runInstaller(c), 0, platform);
      const lines = calls.map((x) => x.line);
      const order = [stopCmd, npm, startCmd];
      let at = -1;
      for (const cmd of order) {
        const i = lines.findIndex((l, n) => n > at && l.startsWith(cmd));
        assert.ok(i > at, platform + ": " + cmd + " в " + lines.join(" | "));
        at = i;
      }
      assert.ok(
        readdirSync(path.join(dir, "data")).some((f) =>
          f.includes("before-update"),
        ),
        platform,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("--reconfigure: только после подтверждения, прежний .env сохраняется копией", async () => {
  const dir = installedDocker();
  try {
    const { io } = fakeIo(["н"]);
    assert.equal(
      await runInstaller(
        ctx(dir, io, fakeExec().exec, {
          preset: { reconfigure: true, target: "local" },
        }),
      ),
      0,
    );
    assert.ok(
      !readdirSync(dir).some((f) => f.startsWith(".env.bak")),
      "без подтверждения ничего",
    );

    const answers = ["д", ...dockerCaddy.slice(1)];
    const r = fakeIo(answers);
    assert.equal(
      await runInstaller(
        ctx(dir, r.io, fakeExec().exec, {
          preset: { reconfigure: true, target: "local" },
        }),
      ),
      0,
    );
    const bak = readdirSync(dir).filter((f) => f.startsWith(".env.bak"));
    assert.equal(bak.length, 1);
    assert.match(readFileSync(path.join(dir, bak[0]), "utf8"), /SECRET_MARK=1/);
    assert.ok(
      !readFileSync(path.join(dir, ".env"), "utf8").includes("SECRET_MARK"),
    );
    assert.equal(
      readFileSync(path.join(dir, "data/attendance.sqlite"), "utf8"),
      "база",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Сервер по SSH: ответы по содержимому удалённой команды.
function fakeServer({
  existing = false,
  os = "Linux",
  fail = {},
  env = "",
} = {}) {
  const calls = [];
  const exec = async (cmd, args, opts = {}) => {
    const line = [cmd, ...args].join(" ");
    calls.push({ cmd, args, line, opts });
    const remote = cmd === "ssh" ? args.at(-1) : "";
    const failed = Object.entries(fail).find(([k]) => line.includes(k));
    if (failed) return { code: failed[1], stdout: "", stderr: "сбой" };
    if (remote === "uname -s")
      return { code: 0, stdout: os + "\n", stderr: "" };
    if (remote.startsWith("test -f"))
      return { code: existing ? 0 : 1, stdout: "", stderr: "" };
    if (remote.startsWith("(ss -ltn"))
      return { code: 1, stdout: "", stderr: "" };
    if (remote.startsWith("cat ")) return { code: 0, stdout: env, stderr: "" };
    if (remote.includes("--format '{{.Health}}'"))
      return { code: 0, stdout: "healthy\n", stderr: "" };
    if (remote.includes("invite-admin"))
      return {
        code: 0,
        stdout: "Логин: gadzhieva.ao\nКод приглашения: ABCD-EFGH-JKMN",
        stderr: "",
      };
    return { code: 0, stdout: "", stderr: "" };
  };
  return { calls, exec };
}
// Куда – удалённый, адрес, пользователь, порт, ключ, папка.
const remoteHead = ["2", "srv.example.edu", "deploy", "", "", ""];
const remoteNew = [
  ...remoteHead,
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
const sshCommands = (calls) =>
  calls.filter((c) => c.cmd === "ssh").map((c) => c.args.at(-1));

test("Удалённо: проверки сервера, архив только из файлов приложения, .env через ввод SSH, запуск, код", async () => {
  const dir = project();
  try {
    writeFileSync(path.join(dir, ".env.local-secret"), "не для сервера");
    mkdirSync(path.join(dir, "backups"));
    const { io, out } = fakeIo(remoteNew);
    const { exec, calls } = fakeServer();
    assert.equal(await runInstaller(ctx(dir, io, exec)), 0);
    const ssh = sshCommands(calls);
    const order = [
      "uname -s",
      "docker compose version",
      "docker info",
      "test -f /opt/attendance-journal/.env",
      "(ss -ltn",
      "mkdir -p /opt/attendance-journal && tar -xzf",
      "umask 077 && cat > /opt/attendance-journal/.env",
      "mkdir -p /opt/attendance-journal/data",
      "cd /opt/attendance-journal && docker compose config --quiet",
      "cd /opt/attendance-journal && docker compose up -d --build",
      "cd /opt/attendance-journal && docker compose exec -T app node scripts/enable-personal-only.mjs",
      "cd /opt/attendance-journal && docker compose exec -T app node scripts/invite-admin.mjs gadzhieva",
    ];
    let at = -1;
    for (const cmd of order) {
      const i = ssh.findIndex((l, n) => n > at && l.startsWith(cmd));
      assert.ok(i > at, "порядок: " + cmd + " в " + ssh.join(" | "));
      at = i;
    }
    const tar = calls.find((c) => c.cmd === "tar");
    assert.ok(tar, "папка не под git – архив через tar");
    const packed = tar.args.slice(tar.args.indexOf(dir) + 1);
    assert.ok(packed.includes("src") && packed.includes("compose.yaml"));
    for (const secret of [
      ".env",
      ".env.local-secret",
      "data",
      "backups",
      "uploads",
    ])
      assert.ok(!packed.includes(secret), secret);
    const scp = calls.find((c) => c.cmd === "scp");
    assert.match(
      scp.args.at(-1),
      /^deploy@srv\.example\.edu:\/tmp\/journal-\d+\.tar\.gz$/,
    );
    const envCall = calls.find(
      (c) => c.cmd === "ssh" && c.args.at(-1).startsWith("umask 077"),
    );
    assert.match(envCall.opts.input, /^DOMAIN=journal\.example\.edu$/m);
    assert.match(envCall.opts.input, /^PROXY_SCALE=1$/m);
    assert.ok(
      calls.every((c) => !c.line.includes("MANAGEMENT_PASSWORD_HASH")),
      "настройки не в аргументах",
    );
    assert.ok(
      !existsSync(path.join(dir, ".env")),
      "локально .env не создаётся",
    );
    assert.match(out.join("\n"), /ssh deploy@srv\.example\.edu/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Удалённо: нет SSH, не Linux, нет прав на Docker, занят порт, небезопасный путь – остановка до копирования кода", async () => {
  for (const [name, server, answers, message] of [
    [
      "нет SSH",
      { fail: { "uname -s": 255 } },
      remoteNew,
      /Нет доступа к deploy@srv\.example\.edu/,
    ],
    ["не Linux", { os: "Darwin" }, remoteNew, /не Linux/],
    [
      "нет прав на Docker",
      { fail: { "docker info": 1 } },
      remoteNew,
      /группу docker/,
    ],
    ["порт занят", {}, remoteNew, /заняты порты 80 или 443/],
    [
      "путь с пробелом",
      {},
      [
        ...remoteHead,
        "journal.example.edu",
        "",
        "мои данные",
        "",
        "",
        "",
        "",
        "д",
        "",
      ],
      /допустимы только латиница/,
    ],
  ]) {
    const dir = project();
    try {
      const { io, out } = fakeIo(answers);
      const server2 = fakeServer(server);
      let exec = server2.exec;
      if (name === "порт занят")
        exec = async (cmd, args, opts) =>
          cmd === "ssh" && args.at(-1).startsWith("(ss -ltn")
            ? { code: 0, stdout: "0.0.0.0:443", stderr: "" }
            : server2.exec(cmd, args, opts);
      assert.equal(await runInstaller(ctx(dir, io, exec)), 1, name);
      assert.match(out.join("\n"), message, name);
      assert.ok(
        !server2.calls.some((c) => c.cmd === "scp"),
        name + ": код не копировался",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("Удалённо: прежняя установка – «Обновить» с копией базы на сервере, настройки не перезаписываются", async () => {
  const dir = project();
  try {
    const { io, out } = fakeIo([...remoteHead, "1"]);
    const { exec, calls } = fakeServer({
      existing: true,
      env: "DOMAIN=journal.example.edu\nDATA_DIR=data\n",
    });
    assert.equal(await runInstaller(ctx(dir, io, exec)), 0);
    const ssh = sshCommands(calls);
    const stop = ssh.findIndex((l) => l.endsWith("docker compose stop app"));
    const copy = ssh.findIndex((l) =>
      l.includes(
        "cp -p /opt/attendance-journal/data/attendance.sqlite /opt/attendance-journal/data/attendance.before-update-",
      ),
    );
    const up = ssh.findIndex((l) => l.endsWith("docker compose up -d --build"));
    assert.ok(stop >= 0 && copy > stop && up > copy, ssh.join(" | "));
    assert.ok(
      calls.some((c) => c.cmd === "scp"),
      "новый код уехал",
    );
    assert.ok(
      !ssh.some((l) => l.startsWith("umask 077")),
      ".env не перезаписан",
    );
    assert.ok(
      !ssh.some(
        (l) => l.includes("invite-admin") || l.includes("enable-personal-only"),
      ),
    );
    assert.match(out.join("\n"), /Обновление готово/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Удалённо: общий пароль – хеш только внутри .env, переданного через ввод SSH", async () => {
  const dir = project();
  try {
    const secret = "общий пароль журнала";
    const answers = [
      ...remoteHead,
      "journal.example.edu",
      "",
      "",
      "",
      "",
      "",
      "2",
      secret,
      secret,
      "д",
      "",
    ];
    const { io, out } = fakeIo(answers);
    const { exec, calls } = fakeServer();
    assert.equal(await runInstaller(ctx(dir, io, exec)), 0);
    const envCall = calls.find(
      (c) => c.cmd === "ssh" && c.args.at(-1).startsWith("umask 077"),
    );
    assert.match(
      envCall.opts.input,
      /^MANAGEMENT_PASSWORD_HASH=[a-f0-9]{32}:[a-f0-9]{128}$/m,
    );
    assert.ok(
      !calls.some(
        (c) => c.line.includes(secret) || (c.opts.input || "").includes(secret),
      ),
    );
    assert.ok(!out.some((t) => t.includes(secret)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Сбой docker compose up: последние строки журнала на экране, ничего не удалено", async () => {
  const dir = project();
  try {
    const { io, out } = fakeIo(dockerCaddy);
    const { exec, calls } = fakeExec({ "docker compose up": 1 });
    assert.equal(await runInstaller(ctx(dir, io, exec)), 1);
    assert.ok(out.includes("строка журнала сервера"));
    assert.match(out.join("\n"), /Не удалось собрать или запустить контейнеры/);
    assert.ok(existsSync(path.join(dir, ".env")));
    assert.ok(!calls.some((c) => /\b(down|rm)\b/.test(c.line)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const dir2 = project();
  try {
    const { io, out } = fakeIo(remoteNew);
    const { exec } = fakeServer({ fail: { "docker compose up": 1 } });
    // Сбой запуска на сервере – тоже строки журнала.
    const logs = async (cmd, args, opts) =>
      cmd === "ssh" && args.at(-1).endsWith("docker compose logs --tail=50 app")
        ? { code: 0, stdout: "строка журнала на сервере", stderr: "" }
        : exec(cmd, args, opts);
    assert.equal(await runInstaller(ctx(dir2, io, logs)), 1);
    assert.ok(out.includes("строка журнала на сервере"));
  } finally {
    rmSync(dir2, { recursive: true, force: true });
  }
});

test("compose.yaml: число копий и TRUST_PROXY берутся из .env, без них – 14 и 1", () => {
  const compose = readFileSync("compose.yaml", "utf8");
  assert.match(compose, /BACKUP_KEEP: \$\{BACKUP_KEEP:-14\}/);
  assert.match(compose, /TRUST_PROXY: \$\{TRUST_PROXY:-1\}/);
  assert.doesNotMatch(compose, /BACKUP_KEEP: "14"|TRUST_PROXY: "1"/);
});
