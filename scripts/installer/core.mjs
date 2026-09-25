// Ядро установщика журнала: вопросы, проверки, .env и план команд.
// Ввод, запуск команд и сеть передаются снаружи (main.mjs или тесты), поэтому
// одинаковый сценарий идёт на Linux, macOS и Windows и проверяется без Docker.
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
} from "node:fs";
import path from "node:path";

export class InstallError extends Error {}
const stop = (message) => {
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
    ask: (a) => ({
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
];
function pathCheck(v) {
  if (!v) return "Укажите папку";
  if (/[\r\n"'$`]/.test(v)) return "Недопустимые символы в пути";
  return null;
}

// Спросить все шаги; «<» – назад к предыдущему показанному шагу.
export async function askSteps(io, steps, answers = {}) {
  const shown = [];
  let i = 0;
  while (i < steps.length) {
    const step = steps[i];
    if (step.when && !step.when(answers)) {
      i++;
      continue;
    }
    const q = step.ask(answers);
    io.print("");
    io.print(q.text + (q.help ? `\n  ${q.help}` : ""));
    if (q.choices)
      q.choices.forEach(([, label], n) => io.print(`  ${n + 1} – ${label}`));
    const def = q.choices
      ? String(q.choices.findIndex(([v]) => v === q.default) + 1)
      : q.default;
    const raw = (await io.ask(def ? `[${def}]` : ">")).trim();
    if (raw === "<") {
      if (shown.length) i = shown.pop();
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
  ].join("\n");
}

// ---------- проверки и запуск ----------

async function run(exec, cmd, args, opts = {}) {
  const r = await exec(cmd, args, opts);
  return r;
}
async function must(exec, cmd, args, message, opts) {
  const r = await run(exec, cmd, args, opts);
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
  if ((await run(exec, "docker", ["--version"])).code !== 0)
    stop(
      "Не найден Docker. Установите Docker Engine (Linux) или Docker Desktop (Windows, macOS): https://docs.docker.com/get-docker/",
    );
  if ((await run(exec, "docker", ["compose", "version"])).code !== 0)
    stop("Нет docker compose (Compose v2). Обновите Docker.");
  if ((await run(exec, "docker", ["info"])).code !== 0)
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
    await run(ctx.exec, "icacls", [
      target,
      "/inheritance:r",
      "/grant:r",
      isDir ? "SYSTEM:(OI)(CI)F" : "SYSTEM:F",
      isDir ? "Administrators:(OI)(CI)F" : "Administrators:F",
      `${ctx.user}:${isDir ? "(OI)(CI)F" : "F"}`,
    ]);
  else chmodSync(target, isDir ? 0o700 : 0o600);
}

async function installLocalDocker(ctx, a) {
  const { cwd, exec, io, net } = ctx;
  if (a.proxy === "caddy") await checkPorts(net);

  const env = buildEnv(
    readFileSync(path.join(cwd, ".env.example"), "utf8"),
    envValues(a),
  );
  io.print("\n== Настройки и папки");
  const envPath = path.join(cwd, ".env");
  writeFileSync(envPath, env, { mode: 0o600 });
  await protect(ctx, envPath, false);
  for (const dir of [a.dataDir, a.backupsDir, a.uploadsDir]) {
    const full = path.resolve(cwd, dir);
    mkdirSync(full, { recursive: true });
    await protect(ctx, full, true);
  }
  // Пользователь контейнера – UID 1000: на Linux папки отдаются ему.
  if (ctx.platform === "linux")
    await must(
      exec,
      "sudo",
      [
        "chown",
        "-R",
        "1000:1000",
        ...[a.dataDir, a.backupsDir, a.uploadsDir].map((d) =>
          path.resolve(cwd, d),
        ),
      ],
      "Не удалось передать папки данных пользователю контейнера (sudo chown).",
      { inherit: true },
    );

  io.print("\n== Проверка и запуск");
  await must(
    exec,
    "docker",
    ["compose", "config", "--quiet"],
    "Ошибка в compose.yaml или .env.",
    { cwd },
  );
  await must(
    exec,
    "docker",
    ["compose", "up", "-d", "--build"],
    "Не удалось собрать или запустить контейнеры.",
    { cwd, inherit: true },
  );
  io.print("Жду ответа журнала…");
  if (!(await waitHealthy(net, a.domain, ctx.sleep))) {
    const logs = await run(
      exec,
      "docker",
      ["compose", "logs", "--tail=50", "app"],
      { cwd },
    );
    io.print(logs.stdout || logs.stderr || "");
    stop(
      "Журнал не ответил за 60 секунд. Последние строки журнала – выше; .env и данные сохранены, ничего не удалено.",
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

// Точка входа ядра. Возвращает код выхода.
export async function runInstaller(ctx) {
  const { io } = ctx;
  try {
    checkProject(ctx.cwd);
    io.print(
      "Установка журнала посещаемости. Enter – ответ по умолчанию в [скобках], «<» – назад.",
    );
    const a = await askSteps(io, STEPS, { ...ctx.preset });
    if (a.target === "remote")
      stop(
        "Установка на удалённый сервер появится в следующей версии установщика.",
      );
    if (a.method === "native")
      stop(
        "Установка без Docker появится в следующей версии установщика; пока – scripts/install.sh --native или scripts/install.ps1 -Native.",
      );
    await checkDocker(ctx.exec);
    io.print("\n" + summary(a));
    const go = (await io.ask("Установить? [д/н]")).trim();
    if (!/^[ДдYy]/.test(go)) {
      io.print("Отменено, ничего не изменено.");
      return 0;
    }
    await installLocalDocker(ctx, a);
    io.print("Журнал работает.");
    await checkHttps(ctx, a.domain);
    return 0;
  } catch (e) {
    if (e instanceof InstallError) {
      io.print("\nОшибка: " + e.message);
      return 1;
    }
    throw e;
  }
}
