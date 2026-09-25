// Ядро установщика журнала: вопросы, проверки, .env и план команд.
// Ввод, запуск команд и сеть передаются снаружи (main.mjs или тесты), поэтому
// одинаковый сценарий идёт на Linux, macOS и Windows и проверяется без Docker.
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  copyFileSync,
} from "node:fs";
import path from "node:path";
import { passwordHash } from "../../src/management-auth.js";
import { passwordProblem } from "../../src/staff-accounts.js";
import { managers } from "../../src/office.js";
import { remoteFlow, remoteAppScript } from "./remote.mjs";

export class InstallError extends Error {}
export const stop = (message) => {
  throw new InstallError(message);
};

// ---------- вопросы ----------

const DOMAIN_RE = /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/;
export const validDomain = (d) => DOMAIN_RE.test(d) && d.includes(".");

// Шаги по порядку; when – показывать ли шаг при уже данных ответах.
// ask(answers) возвращает описание вопроса: text, help, default, choices, check.
export const STEPS = [
  {
    id: "target",
    ask: () => ({
      text: "Куда ставить журнал?",
      help: "На этот компьютер – сюда же; на удалённый Linux-сервер – по SSH, только через Docker.",
      choices: [
        ["local", "На этот компьютер"],
        ["remote", "На удалённый Linux-сервер по SSH"],
      ],
      default: "local",
    }),
  },
  {
    id: "method",
    when: (a) => a.target === "local",
    ask: () => ({
      text: "Как ставить?",
      help: "Docker – журнал и Caddy в контейнерах. Без Docker – Node.js 24 и служба системы.",
      choices: [
        ["docker", "Через Docker"],
        ["native", "Без Docker"],
      ],
      default: "docker",
    }),
  },
  {
    id: "domain",
    ask: () => ({
      text: "Адрес сайта без https://",
      help: "Домен должен указывать на сервер, например journal.pravo.hse.ru.",
      check: (v) => (validDomain(v) ? null : "Это не похоже на доменное имя"),
    }),
  },
  {
    id: "proxy",
    ask: (a) => ({
      text: "HTTPS",
      help:
        a.method === "native"
          ? "Без Docker HTTPS даёт ваш прокси (nginx, Caddy, IIS)."
          : "Встроенный Caddy сам получает сертификат и занимает порты 80 и 443. Свой прокси – если на сервере уже есть сайты.",
      choices:
        a.method === "native"
          ? [["own", "Свой прокси сервера"]]
          : [
              ["caddy", "Встроенный Caddy"],
              ["own", "Свой прокси сервера"],
            ],
      default: a.method === "native" ? "own" : "caddy",
    }),
  },
  {
    id: "trustProxy",
    when: (a) => a.proxy === "own",
    ask: () => ({
      text: "Сколько прокси стоит перед журналом",
      help: "Обычно 1. Прокси обязан передавать заголовок Host без изменений, иначе журнал ответит «Недопустимый адрес сервера».",
      default: "1",
      check: (v) => (/^[1-9]$/.test(v) ? null : "Нужно число от 1 до 9"),
    }),
  },
  {
    id: "dataDir",
    ask: () => ({
      text: "Папка базы",
      help: "Можно вынести на отдельный диск.",
      default: "data",
      check: pathCheck,
    }),
  },
  {
    id: "backupsDir",
    ask: (a) => ({
      text: "Папка резервных копий",
      help: "Копии базы раз в сутки. Их нужно выгружать на внешнее хранилище вместе со сканами.",
      default: a.method === "native" ? "data/backups" : "backups",
      check: pathCheck,
    }),
  },
  {
    id: "uploadsDir",
    ask: (a) => ({
      text: "Папка сканов документов",
      help: "Сканы не входят в копии базы.",
      default: a.method === "native" ? "data/uploads" : "uploads",
      check: pathCheck,
    }),
  },
  {
    id: "backupKeep",
    ask: () => ({
      text: "Сколько резервных копий хранить",
      default: "14",
      check: (v) =>
        /^\d{1,3}$/.test(v) && Number(v) > 0 ? null : "Нужно число от 1 до 999",
    }),
  },
  {
    id: "auth",
    ask: () => ({
      text: "Как сотрудники входят в журнал?",
      help: "Личные пароли: у каждого свой, первый задаётся по коду приглашения. Общий пароль один на всех и не подтверждает, кто вошёл.",
      choices: [
        ["personal", "Личные пароли"],
        ["shared", "Только общий пароль"],
      ],
      default: "personal",
    }),
  },
];
function pathCheck(v) {
  if (!v) return "Укажите папку";
  if (/[\r\n"'$`]/.test(v)) return "Недопустимые символы в пути";
  return null;
}

// Спросить все шаги; «<» – назад к предыдущему показанному шагу.
// Ответы, заданные ключами запуска (--docker, --native), не спрашиваются.
// back – «<» на первом вопросе возвращает null: вызывающий уходит на
// предыдущий этап. Прежний ответ на шаг становится ответом по умолчанию.
export const BACK = null;
export async function askSteps(
  io,
  steps,
  answers = {},
  { fixed = new Set(Object.keys(answers)), back = false } = {},
) {
  const shown = [];
  let i = 0;
  while (i < steps.length) {
    const step = steps[i];
    if (fixed.has(step.id) || (step.when && !step.when(answers))) {
      i++;
      continue;
    }
    const q = step.ask(answers);
    const prior = answers[step.id] ?? q.default;
    io.print("");
    io.print(q.text + (q.help ? `\n  ${q.help}` : ""));
    if (q.choices)
      q.choices.forEach(([, label], n) => io.print(`  ${n + 1} – ${label}`));
    const def = q.choices
      ? String(q.choices.findIndex(([v]) => v === prior) + 1 || "")
      : prior;
    const raw = (await io.ask(def ? `[${def}]` : ">")).trim();
    if (raw === "<") {
      if (shown.length) i = shown.pop();
      else if (back) return BACK;
      else io.print("Это первый вопрос.");
      continue;
    }
    let value = raw || def || "";
    if (q.choices) {
      const choice = q.choices[Number(value) - 1];
      if (!choice) {
        io.print(
          `Ответьте числом от 1 до ${q.choices.length} или «<» – назад.`,
        );
        continue;
      }
      value = choice[0];
    }
    const problem = q.check ? q.check(value) : value ? null : "Нужен ответ";
    if (problem) {
      io.print(problem);
      continue;
    }
    answers[step.id] = value;
    shown.push(i);
    i++;
  }
  return answers;
}

// ---------- .env ----------

// Значения поверх шаблона .env.example: заменить строку KEY= или дописать.
export function buildEnv(template, values) {
  const lines = template.replace(/\s+$/, "").split(/\r?\n/);
  for (const [key, value] of Object.entries(values)) {
    const v = String(value);
    if (/[\r\n]/.test(v)) stop(`Значение ${key} содержит перевод строки`);
    const i = lines.findIndex((l) => l.startsWith(key + "="));
    if (i >= 0) lines[i] = `${key}=${v}`;
    else lines.push(`${key}=${v}`);
  }
  return lines.join("\n").replace(/\n*$/, "\n");
}

export function envValues(a) {
  const docker = a.method !== "native";
  const values = {
    DOMAIN: a.domain,
    APP_ORIGIN: `https://${a.domain}`,
    DEMO_MODE: "false",
    DATA_MODE: "live",
    AUTH_MODE: "selection",
    AUTO_BACKUP: "true",
    BACKUP_KEEP: a.backupKeep,
    TRUST_PROXY: a.proxy === "own" ? a.trustProxy : "1",
    MANAGEMENT_PASSWORD_HASH: a.passwordHash || "",
  };
  if (docker) {
    // Пути хоста для compose.yaml; внутри контейнера папки постоянные.
    Object.assign(values, {
      DATA_DIR: a.dataDir,
      BACKUPS_DIR: a.backupsDir,
      UPLOADS_DIR: a.uploadsDir,
      PROXY_SCALE: a.proxy === "caddy" ? "1" : "0",
    });
  } else {
    Object.assign(values, {
      HOST: "127.0.0.1",
      PORT: "3100",
      DB_PATH: path.posix.join(
        a.dataDir.replaceAll("\\", "/"),
        "attendance.sqlite",
      ),
      BACKUP_DIR: a.backupsDir,
      UPLOAD_DIR: a.uploadsDir,
    });
  }
  for (const key of ["DOMAIN", "BACKUP_KEEP", "TRUST_PROXY"])
    if (!values[key]) stop(`Пустое обязательное значение ${key}`);
  return values;
}

// Сводка перед установкой – без секретов.
export function summary(a) {
  const target =
    a.target === "remote"
      ? `удалённый сервер ${a.sshUser}@${a.sshHost}`
      : a.method === "native"
        ? "этот компьютер, без Docker"
        : "этот компьютер, через Docker";
  return [
    `Куда: ${target}`,
    `Сайт: https://${a.domain}`,
    `HTTPS: ${a.proxy === "caddy" ? "встроенный Caddy" : `свой прокси (TRUST_PROXY=${a.trustProxy})`}`,
    `Папки: база – ${a.dataDir}, копии – ${a.backupsDir}, сканы – ${a.uploadsDir}`,
    `Копий хранить: ${a.backupKeep}`,
    `Вход: ${a.auth === "shared" ? "только общий пароль" : "личные пароли"}`,
  ].join("\n");
}

// ---------- проверки и запуск ----------

export async function must(exec, cmd, args, message, opts) {
  const r = await exec(cmd, args, opts);
  if (r.code !== 0)
    stop(
      message +
        (r.stderr
          ? `\n${r.stderr.trim().split("\n").slice(-5).join("\n")}`
          : ""),
    );
  return r;
}

export function checkProject(cwd) {
  for (const f of [
    "src/server.js",
    ".env.example",
    "compose.yaml",
    "package.json",
  ])
    if (!existsSync(path.join(cwd, f)))
      stop("Запускайте установщик из папки журнала: не найден " + f);
}

async function checkDocker(exec) {
  if ((await exec("docker", ["--version"])).code !== 0)
    stop(
      "Не найден Docker. Установите Docker Engine (Linux) или Docker Desktop (Windows, macOS): https://docs.docker.com/get-docker/",
    );
  if ((await exec("docker", ["compose", "version"])).code !== 0)
    stop("Нет docker compose (Compose v2). Обновите Docker.");
  if ((await exec("docker", ["info"])).code !== 0)
    stop(
      "Docker не запущен или у пользователя нет к нему доступа (группа docker).",
    );
}

async function checkPorts(net) {
  for (const port of [80, 443])
    if (!(await net.portFree(port)))
      stop(
        `Порт ${port} занят. Встроенному Caddy нужны 80 и 443 – освободите их или выберите «Свой прокси сервера».`,
      );
}

async function waitHealthy(net, domain, sleep, seconds = 60) {
  for (let t = 0; t < seconds; t += 2) {
    if (
      (await net.get("http://127.0.0.1:3100/healthz", { host: domain })) === 200
    )
      return true;
    await sleep(2000);
  }
  return false;
}

// Права на .env и папки: 600/700 на Linux и macOS, на Windows – администраторы и система.
async function protect(ctx, target, isDir) {
  if (ctx.platform === "win32")
    await must(
      ctx.exec,
      "icacls",
      [
        target,
        "/inheritance:r",
        "/grant:r",
        isDir ? "SYSTEM:(OI)(CI)F" : "SYSTEM:F",
        isDir ? "Administrators:(OI)(CI)F" : "Administrators:F",
        `${ctx.user}:${isDir ? "(OI)(CI)F" : "F"}`,
      ],
      `Не удалось закрыть права на ${target} (icacls).`,
    );
  else chmodSync(target, isDir ? 0o700 : 0o600);
}

// .env и папки данных – общее для всех способов установки на этот компьютер.
async function writeConfig(ctx, a) {
  const { cwd, io } = ctx;
  const env = buildEnv(
    readFileSync(path.join(cwd, ".env.example"), "utf8"),
    envValues(a),
  );
  io.print("\n== Настройки и папки");
  const envPath = path.join(cwd, ".env");
  // Перезаполнение: прежний .env – копией с теми же закрытыми правами.
  if (existsSync(envPath)) {
    const bak = `${envPath}.bak.${stamp()}`;
    copyFileSync(envPath, bak);
    await protect(ctx, bak, false);
    io.print("Прежние настройки сохранены: " + bak);
  }
  writeFileSync(envPath, env, { mode: 0o600 });
  await protect(ctx, envPath, false);
  for (const dir of dataDirs(ctx, a)) {
    mkdirSync(dir, { recursive: true });
    await protect(ctx, dir, true);
  }
}
const dataDirs = (ctx, a) =>
  [a.dataDir, a.backupsDir, a.uploadsDir].map((d) => path.resolve(ctx.cwd, d));

async function installLocalDocker(ctx, a) {
  const { cwd, exec, io, net } = ctx;
  if (a.proxy === "caddy") await checkPorts(net);
  await writeConfig(ctx, a);
  // Пользователь контейнера – UID 1000: на Linux папки отдаются ему через
  // сам Docker, без sudo – достаточно прав на Docker.
  if (ctx.platform === "linux") {
    const dirs = dataDirs(ctx, a);
    await must(
      exec,
      "docker",
      [
        "run",
        "--rm",
        ...dirs.flatMap((d, i) => ["-v", `${d}:/d${i}`]),
        "node:24-bookworm-slim",
        "chown",
        "-R",
        "1000:1000",
        ...dirs.map((d, i) => `/d${i}`),
      ],
      "Не удалось передать папки данных пользователю контейнера.",
      { inherit: true },
    );
  }

  io.print("\n== Проверка и запуск");
  await must(
    exec,
    "docker",
    ["compose", "config", "--quiet"],
    "Ошибка в compose.yaml или .env.",
    { cwd },
  );
  await dockerUp(ctx, a);
}

// Сборка и запуск контейнеров, затем ожидание ответа. Неуспех любого шага –
// последние строки журнала на экран (при встроенном Caddy сам `up` падает,
// если журнал не стал здоровым).
async function dockerUp(ctx, a) {
  const { exec, cwd } = ctx;
  const logs = () =>
    exec("docker", ["compose", "logs", "--tail=50", "app"], { cwd });
  const up = await exec("docker", ["compose", "up", "-d", "--build"], {
    cwd,
    inherit: true,
  });
  if (up.code !== 0) {
    const r = await logs();
    ctx.io.print(r.stdout || r.stderr || "");
    stop(
      "Не удалось собрать или запустить контейнеры. Последние строки журнала – выше; .env и данные сохранены, ничего не удалено.",
    );
  }
  await healthyOrLogs(ctx, a, logs);
}

async function healthyOrLogs(ctx, a, readLogs) {
  ctx.io.print("Жду ответа журнала…");
  if (await waitHealthy(ctx.net, a.domain, ctx.sleep)) return;
  const logs = await readLogs();
  ctx.io.print(logs.stdout || logs.stderr || "");
  stop(
    "Журнал не ответил за 60 секунд. Последние строки журнала – выше; .env и данные сохранены, ничего не удалено.",
  );
}

// Последние 50 строк журнала сервера без Docker на Windows.
const tailLog = (file) => ({
  stdout: existsSync(file)
    ? readFileSync(file, "utf8").split("\n").slice(-50).join("\n")
    : `Нет файла ${file}`,
});

// ---------- без Docker ----------

export const SERVICE = "attendance-journal";
export const TASK = "AttendanceJournal";
// Строка в одинарных кавычках PowerShell: одинарная кавычка удваивается.
const psq = (s) => "'" + String(s).replaceAll("'", "''") + "'";
// Остановить процесс журнала: задача запускает cmd, а он – node.
const STOP_NODE =
  "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*src\\server.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }";
const npmCmd = (ctx) => (ctx.platform === "win32" ? "npm.cmd" : "npm");

async function checkNative(ctx) {
  const { exec, platform } = ctx;
  if (platform === "darwin")
    stop(
      "На macOS журнал ставится только через Docker (Docker Desktop). Выберите «Через Docker».",
    );
  if (platform === "linux") {
    if (ctx.isRoot)
      stop(
        "Запускайте установщик обычным пользователем с правом sudo, не от root.",
      );
    if ((await exec("systemctl", ["--version"])).code !== 0)
      stop(
        "Нет systemd: без Docker журнал ставится только как служба systemd. Выберите «Через Docker».",
      );
    // Служба ставится через sudo: право проверяется заранее, пароль спросит sudo.
    if ((await exec("sudo", ["-v"], { inherit: true })).code !== 0)
      stop("Нужно право sudo: без него службу systemd не поставить.");
  }
  if (platform === "win32" && (await exec("net", ["session"])).code !== 0)
    stop(
      "Для установки без Docker запустите установщик от имени администратора.",
    );
}

export function systemdUnit(ctx, a) {
  return `[Unit]
Description=Журнал посещаемости иностранных студентов
After=network.target

[Service]
User=${ctx.user}
WorkingDirectory=${ctx.cwd}
ExecStart="${ctx.nodePath}" "--env-file=${path.posix.join(ctx.cwd, ".env")}" src/server.js
Restart=on-failure
RestartSec=5
TimeoutStopSec=35
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
${dataDirs(ctx, a)
  .map((d) => `ReadWritePaths="${d}"`)
  .join("\n")}

[Install]
WantedBy=multi-user.target
`;
}

// Задача планировщика: cmd-файл запуска в папке базы и регистрация от имени SYSTEM.
export function windowsTaskScript(ctx, a) {
  // Пути Windows строятся по правилам Windows, где бы ни шли тесты.
  const dir = ctx.cwd;
  const data = path.win32.resolve(dir, a.dataDir);
  const start = path.win32.join(data, "start-journal.cmd");
  const log = path.win32.join(data, "server.log");
  const cmd = [
    "@echo off",
    `cd /d "${dir}"`,
    `"${ctx.nodePath}" --env-file=.env src\\server.js >> "${log}" 2>&1`,
  ].join("\r\n");
  return [
    "$ErrorActionPreference = 'Stop'",
    `[IO.File]::WriteAllText(${psq(start)}, ${psq(cmd)}, (New-Object System.Text.UTF8Encoding($false)))`,
    `if (Get-ScheduledTask -TaskName '${TASK}' -ErrorAction SilentlyContinue) { Stop-ScheduledTask -TaskName '${TASK}' -ErrorAction SilentlyContinue }`,
    STOP_NODE,
    `$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument ('/c "' + ${psq(start)} + '"')`,
    "$trigger = New-ScheduledTaskTrigger -AtStartup",
    "$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest",
    "$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable",
    `Register-ScheduledTask -TaskName '${TASK}' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null`,
    `Start-ScheduledTask -TaskName '${TASK}'`,
  ].join("; ");
}

async function installLocalNative(ctx, a) {
  const { cwd, exec, io } = ctx;
  io.print("\n== Зависимости");
  await must(
    exec,
    npmCmd(ctx),
    ["ci", "--omit=dev"],
    "npm ci завершился с ошибкой.",
    {
      cwd,
      inherit: true,
    },
  );
  await writeConfig(ctx, a);
  if (ctx.platform === "win32") {
    io.print(`\n== Задача планировщика ${TASK}`);
    await must(
      exec,
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        windowsTaskScript(ctx, a),
      ],
      "Не удалось зарегистрировать задачу планировщика.",
    );
    await healthyOrLogs(ctx, a, async () =>
      tailLog(path.resolve(cwd, a.dataDir, "server.log")),
    );
  } else {
    io.print(`\n== Служба systemd ${SERVICE}`);
    await must(
      exec,
      "sudo",
      ["tee", `/etc/systemd/system/${SERVICE}.service`],
      "Не удалось записать службу systemd (sudo).",
      { input: systemdUnit(ctx, a) },
    );
    for (const args of [
      ["daemon-reload"],
      ["enable", SERVICE],
      ["restart", SERVICE],
    ])
      await must(
        exec,
        "sudo",
        ["systemctl", ...args],
        "Ошибка systemctl " + args.join(" "),
      );
    await healthyOrLogs(ctx, a, () =>
      exec("sudo", ["journalctl", "-u", SERVICE, "-n", "50", "--no-pager"]),
    );
  }
}

async function checkHttps(ctx, domain) {
  const status = await ctx.net.get(`https://${domain}/healthz`, {
    timeout: 10000,
  });
  if (status === 200) ctx.io.print(`Сайт открывается: https://${domain}`);
  else
    ctx.io.print(
      `Внимание: https://${domain} пока не отвечает. Так бывает, пока Caddy получает сертификат или домен ещё не указывает на сервер; повторите проверку через несколько минут. Журнал при этом работает.`,
    );
}

// Общий пароль: скрытый ввод дважды, в настройки – только хеш.
export async function askSharedPassword(io) {
  io.print(
    "\nВнимание: общий пароль не подтверждает, кто вошёл. Перед работой с реальными данными ограничьте доступ к сайту сетью университета или VPN.",
  );
  for (;;) {
    const first = await io.askSecret("Общий пароль (не отображается):");
    const problem = passwordProblem(first);
    if (problem) {
      io.print(problem);
      continue;
    }
    if ((await io.askSecret("Повторите пароль:")) === first)
      return passwordHash(first);
    io.print("Пароли не совпадают, введите ещё раз.");
  }
}

// Серверный скрипт журнала рядом с установленным приложением.
const appScript = (ctx, a, script, args = []) =>
  a.target === "remote"
    ? remoteAppScript(ctx, a, script, args)
    : a.method === "native"
      ? ctx.exec(ctx.nodePath, [`scripts/${script}`, ...args], {
          cwd: ctx.cwd,
          env: { DB_PATH: envValues(a).DB_PATH },
        })
      : ctx.exec(
          "docker",
          [
            "compose",
            "exec",
            "-T",
            "app",
            "node",
            `scripts/${script}`,
            ...args,
          ],
          { cwd: ctx.cwd },
        );

// Режим входа и первый код администратору после успешного запуска.
async function finishAccess(ctx, a) {
  const { io } = ctx;
  // На уже работавшей базе режим входа меняется только после вопроса.
  const switchMode =
    a.auth === "personal" &&
    (!a.onExistingData ||
      (await confirm(
        io,
        "Включить вход только по личным паролям на существующей базе? Общий пароль и выбор себя из списка перестанут работать.",
      )));
  if (switchMode) {
    const r = await appScript(ctx, a, "enable-personal-only.mjs");
    if (r.code !== 0)
      stop("Не удалось включить вход только по личным паролям:\n" + r.stderr);
    io.print(r.stdout.trim());
  }
  const admins = managers.filter((m) => m.role === "admin");
  const pick = await askSteps(io, [
    {
      id: "admin",
      ask: () => ({
        text: "Кому выдать первый код приглашения?",
        help: "Этот сотрудник полного доступа первым войдёт в журнал и выдаст коды остальным.",
        choices: admins.map((m) => [m.id, m.name]),
        default: "gadzhieva",
      }),
    },
  ]);
  const r = await appScript(ctx, a, "invite-admin.mjs", [pick.admin]);
  if (r.code !== 0) stop("Не удалось выдать код приглашения:\n" + r.stderr);
  io.print("\n== Первый вход\n" + r.stdout.trim());
}

function memo(ctx, a) {
  const docker = a.method !== "native";
  const lines = [
    "",
    "== Что дальше",
    `Сайт: https://${a.domain} – «Первый вход по коду приглашения», задать пароль.`,
    "Реестр: «Студенты» → «Обновить реестр из Excel».",
    "Доступ остальным: «Сотрудники» → «Выдать доступ» или «Выгрузить коды приглашения».",
    `Где данные: база – ${a.dataDir}, копии – ${a.backupsDir}, сканы – ${a.uploadsDir}.`,
    "Копии базы не включают сканы: выгружайте обе папки на внешнее хранилище вместе.",
  ];
  if (a.target === "remote")
    lines.push(
      `Журнал сервера: ssh ${a.sshUser}@${a.sshHost}, затем cd ${a.remoteDir} && docker compose logs --tail=100 app`,
      `Перезапуск: cd ${a.remoteDir} && docker compose restart app (на сервере)`,
    );
  else if (docker)
    lines.push(
      "Журнал сервера: docker compose logs --tail=100 app",
      "Перезапуск: docker compose restart app",
    );
  else if (ctx.platform === "win32")
    lines.push(
      `Журнал сервера: ${path.join(a.dataDir, "server.log")}`,
      `Перезапуск: снова установщик («Обновить») или Stop-ScheduledTask ${TASK}; Start-ScheduledTask ${TASK}`,
      "HTTPS: настройте свой прокси (Caddy для Windows или IIS) на http://127.0.0.1:3100 с сохранением заголовка Host.",
    );
  else
    lines.push(
      `Журнал сервера: sudo journalctl -u ${SERVICE} -n 100`,
      `Перезапуск: sudo systemctl restart ${SERVICE}`,
      "HTTPS: настройте свой прокси (nginx, Caddy) на http://127.0.0.1:3100 с сохранением заголовка Host – пример в INSTALL.md.",
    );
  lines.push(
    "Обновление: снова запустите установщик – он предложит «Обновить».",
  );
  if (a.auth === "shared")
    lines.push(
      "Общий пароль не подтверждает личность: до работы с реальными данными ограничьте доступ к сайту.",
    );
  ctx.io.print(lines.join("\n"));
}

// ---------- прежняя установка ----------

export function parseEnv(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m) values[m[1]] = m[2];
  }
  return values;
}
export const readEnvFile = (file) => parseEnv(readFileSync(file, "utf8"));

// Файл базы прежней установки по её .env (или по умолчанию).
function existingDb(cwd, env, method) {
  const rel =
    method === "docker"
      ? path.join(env.DATA_DIR || "data", "attendance.sqlite")
      : env.DB_PATH || "data/attendance.sqlite";
  return path.resolve(cwd, rel);
}

// Прежняя установка в этой папке: есть .env или база журнала.
function findExisting(ctx) {
  const envPath = path.join(ctx.cwd, ".env");
  const hasEnv = existsSync(envPath);
  const env = hasEnv ? readEnvFile(envPath) : {};
  const dbs = [
    existingDb(ctx.cwd, env, "docker"),
    existingDb(ctx.cwd, env, "native"),
  ];
  const db = dbs.find((f) => existsSync(f));
  if (!hasEnv && !db) return null;
  return { envPath, env, hasEnv, hasDb: Boolean(db) };
}

// Способ прежней установки: по .env, службе systemd или задаче планировщика.
async function guessMethod(ctx, env) {
  if (env.PROXY_SCALE !== undefined || env.DATA_DIR !== undefined)
    return "docker";
  if (
    ctx.platform === "linux" &&
    existsSync(`/etc/systemd/system/${SERVICE}.service`)
  )
    return "native";
  if (
    ctx.platform === "win32" &&
    (
      await ctx.exec("powershell.exe", [
        "-NoProfile",
        "-Command",
        `Get-ScheduledTask -TaskName '${TASK}'`,
      ])
    ).code === 0
  )
    return "native";
  return "docker";
}

export const stamp = () =>
  new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");

// Копия базы (и её журнала WAL) рядом с базой – при остановленном журнале.
function backupDb(ctx, db) {
  if (!existsSync(db)) {
    ctx.io.print("Базы ещё нет – копировать нечего.");
    return;
  }
  const target = db.replace(/\.sqlite$/, `.before-update-${stamp()}.sqlite`);
  copyFileSync(db, target);
  if (existsSync(db + "-wal")) copyFileSync(db + "-wal", target + "-wal");
  ctx.io.print("Копия базы: " + target);
}

async function stopJournal(ctx, a) {
  const { exec, cwd } = ctx;
  if (a.method === "docker")
    return must(
      exec,
      "docker",
      ["compose", "stop", "app"],
      "Не удалось остановить журнал.",
      { cwd },
    );
  if (ctx.platform === "win32")
    return must(
      exec,
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `Stop-ScheduledTask -TaskName '${TASK}' -ErrorAction SilentlyContinue; ${STOP_NODE}`,
      ],
      "Не удалось остановить журнал.",
    );
  return must(
    exec,
    "sudo",
    ["systemctl", "stop", SERVICE],
    "Не удалось остановить службу журнала.",
  );
}

async function updateLocal(ctx, a, found) {
  const { exec, cwd, io } = ctx;
  const env = found.env;
  a.domain = env.DOMAIN;
  if (!a.domain)
    stop(
      "В прежнем .env нет DOMAIN – не по чему проверить журнал после обновления. Запустите установщик с ключом --reconfigure.",
    );
  if (existsSync(path.join(cwd, ".git"))) {
    io.print("\n== Новый код");
    await must(
      exec,
      "git",
      ["pull", "--ff-only"],
      "git pull не удался – обновите код вручную и повторите.",
      { cwd, inherit: true },
    );
  } else
    io.print(
      "\nПапка не под git: обновляется код, который лежит в ней сейчас.",
    );
  io.print("\n== Остановка и копия базы");
  await stopJournal(ctx, a);
  backupDb(ctx, existingDb(cwd, env, a.method));
  io.print("\n== Запуск новой версии");
  if (a.method === "docker") {
    await dockerUp(ctx, a);
  } else {
    await must(
      exec,
      npmCmd(ctx),
      ["ci", "--omit=dev"],
      "npm ci завершился с ошибкой.",
      { cwd, inherit: true },
    );
    if (ctx.platform === "win32") {
      await must(
        exec,
        "powershell.exe",
        ["-NoProfile", "-Command", `Start-ScheduledTask -TaskName '${TASK}'`],
        "Не удалось запустить задачу планировщика.",
      );
      await healthyOrLogs(ctx, a, async () =>
        tailLog(
          path.join(path.dirname(existingDb(cwd, env, "native")), "server.log"),
        ),
      );
    } else {
      await must(
        exec,
        "sudo",
        ["systemctl", "start", SERVICE],
        "Не удалось запустить службу журнала.",
      );
      await healthyOrLogs(ctx, a, () =>
        exec("sudo", ["journalctl", "-u", SERVICE, "-n", "50", "--no-pager"]),
      );
    }
  }
  io.print(
    "\nОбновление готово: .env, база, сканы и резервные копии не менялись.",
  );
}

// Вопрос при найденной установке – один для этого компьютера и сервера.
export const UPDATE_STEP = {
  id: "action",
  ask: () => ({
    text: "Что сделать?",
    help: "Обновить – копия базы, новый код и перезапуск; настройки, база, сканы и копии не меняются.",
    choices: [
      ["update", "Обновить"],
      ["exit", "Выйти, ничего не меняя"],
    ],
    // Enter ничего не меняет: обновление выбирается явно.
    default: "exit",
  }),
};
// Вопрос «да/нет»; всё, кроме «д»/«y», – нет.
export const confirm = async (io, text) =>
  /^[ДдYy]/.test((await io.ask(text + " [д/н]")).trim());

// Найдена прежняя установка: только «Обновить» или «Выйти».
async function existingFlow(ctx, a, found) {
  const { io } = ctx;
  io.print(
    "\nВ этой папке уже установлен журнал (" +
      (found.hasEnv ? "есть .env" : "есть база") +
      ").",
  );
  const guessed = await guessMethod(ctx, found.env);
  // Ключи --update и --docker/--native отвечают на вопросы заранее.
  const fixed = {};
  if (ctx.preset.update) fixed.action = "update";
  if (ctx.preset.method) fixed.method = ctx.preset.method;
  const pick = await askSteps(
    io,
    [
      UPDATE_STEP,
      {
        id: "method",
        when: (p) => p.action === "update",
        ask: () => ({
          text: "Как установлен журнал?",
          choices: [
            ["docker", "Через Docker"],
            ["native", "Без Docker"],
          ],
          default: guessed,
        }),
      },
    ],
    fixed,
  );
  if (pick.action !== "update") {
    io.print("Ничего не изменено.");
    return 0;
  }
  a.method = pick.method;
  if (a.method === "native") await checkNative(ctx);
  else await checkDocker(ctx.exec);
  await updateLocal(ctx, a, found);
  return 0;
}

// Точка входа ядра. Возвращает код выхода.
export async function runInstaller(ctx) {
  const { io } = ctx;
  try {
    checkProject(ctx.cwd);
    io.print(
      "Установка журнала посещаемости. Enter – ответ по умолчанию в [скобках], «<» – назад.",
    );
    // Этапы вопросов: «куда», «как» с проверками способа, остальное. «<» на
    // первом вопросе этапа возвращает на предыдущий с прежними ответами,
    // проверки этапа повторяются. Ответы из ключей запуска не спрашиваются.
    const { update, reconfigure, ...preset } = ctx.preset;
    const fixed = new Set(Object.keys(preset));
    const a = { ...preset };
    const finish = async (b) => {
      await finishAccess(ctx, b);
      await checkHttps(ctx, b.domain);
      memo(ctx, b);
    };
    for (let phase = 0; phase < 3;) {
      if (phase === 0) {
        await askSteps(io, STEPS.slice(0, 1), a, { fixed });
        if (a.target === "remote") {
          const r = await remoteFlow(ctx, a, { finish, fixed });
          if (r !== BACK) return r;
          if (fixed.has("target")) io.print("Это первый вопрос.");
          continue;
        }
        const found = findExisting(ctx);
        if (found && !reconfigure) return await existingFlow(ctx, a, found);
        if (found) {
          if (
            !(await confirm(
              io,
              "Заполнить настройки заново? Прежний .env сохранится копией, база и сканы не меняются.",
            ))
          ) {
            io.print("Ничего не изменено.");
            return 0;
          }
          a.onExistingData = found.hasDb;
        }
        phase = 1;
      } else if (phase === 1) {
        if (
          !(await askSteps(io, STEPS.slice(1, 2), a, {
            fixed,
            back: !fixed.has("target"),
          }))
        ) {
          phase = 0;
          continue;
        }
        if (a.method === "native") await checkNative(ctx);
        else await checkDocker(ctx.exec);
        phase = 2;
      } else {
        const backTo = fixed.has("method") ? (fixed.has("target") ? -1 : 0) : 1;
        if (
          !(await askSteps(io, STEPS.slice(2), a, { fixed, back: backTo >= 0 }))
        ) {
          phase = backTo;
          continue;
        }
        phase = 3;
      }
    }
    if (a.auth === "shared") a.passwordHash = await askSharedPassword(io);
    io.print("\n" + summary(a));
    if (!(await confirm(io, "Установить?"))) {
      io.print("Отменено, ничего не изменено.");
      return 0;
    }
    if (a.method === "native") await installLocalNative(ctx, a);
    else await installLocalDocker(ctx, a);
    io.print("Журнал работает.");
    await finish(a);
    return 0;
  } catch (e) {
    if (e instanceof InstallError) {
      io.print("\nОшибка: " + e.message);
      return 1;
    }
    throw e;
  }
}
