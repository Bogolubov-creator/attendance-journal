// Установка на удалённый Linux-сервер по SSH: только через Docker.
// Пароль SSH, если нужен, спрашивает сам ssh – установщик его не видит.
import { existsSync, rmSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  stop,
  must,
  askSteps,
  STEPS,
  buildEnv,
  envValues,
  summary,
  stamp,
  askSharedPassword,
  BACK,
  parseEnv,
  UPDATE_STEP,
  confirm,
} from "./core.mjs";

const HOST_RE =
  /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$|^\[?[0-9a-fA-F:.]+\]?$/;
const USER_RE = /^[a-z_][a-z0-9_.-]*$/;
// Папка на сервере попадает в команды оболочки сервера – только безопасные символы.
const DIR_RE = /^\/[A-Za-z0-9._/-]+$/;

export const REMOTE_STEPS = [
  {
    id: "sshHost",
    ask: () => ({
      text: "Адрес сервера",
      help: "Имя или IP-адрес Linux-сервера с Docker.",
      check: (v) => (HOST_RE.test(v) ? null : "Это не похоже на адрес сервера"),
    }),
  },
  {
    id: "sshUser",
    ask: () => ({
      text: "Пользователь SSH",
      help: "Нужны права на Docker (группа docker). Пароль, если нужен, спросит сам SSH.",
      check: (v) => (USER_RE.test(v) ? null : "Недопустимое имя пользователя"),
    }),
  },
  {
    id: "sshPort",
    ask: () => ({
      text: "Порт SSH",
      help: "Обычно 22, если ИТ-служба не называла другой.",
      default: "22",
      check: (v) =>
        /^\d{1,5}$/.test(v) && Number(v) > 0 && Number(v) < 65536
          ? null
          : "Нужен номер порта",
    }),
  },
  {
    id: "sshKey",
    ask: () => ({
      text: "Путь к ключу SSH (Enter – ключ по умолчанию)",
      help: "Файл закрытого ключа, например ~/.ssh/id_ed25519. Без ключа SSH спросит пароль.",
      default: "-",
      check: (v) =>
        v === "-" || existsSync(v) ? null : "Файл ключа не найден",
    }),
  },
  {
    id: "remoteDir",
    ask: () => ({
      text: "Папка журнала на сервере",
      help: "Сюда ляжет код, .env и по умолчанию папки данных.",
      default: "/opt/attendance-journal",
      check: (v) =>
        DIR_RE.test(v)
          ? null
          : "Нужен абсолютный путь из латиницы, цифр, . _ - /",
    }),
  },
];

const keyArgs = (a) => (a.sshKey && a.sshKey !== "-" ? ["-i", a.sshKey] : []);
// Одно соединение на всю установку (Linux, macOS): пароль SSH спрашивается
// один раз. Каталог сокета – короткий путь в /tmp с правами 700.
let control = null;
const controlArgs = () =>
  control
    ? [
        "-o",
        "ControlMaster=auto",
        "-o",
        `ControlPath=${control}/%C`,
        "-o",
        "ControlPersist=120",
      ]
    : [];
function openControl(ctx) {
  if (ctx.platform === "win32") {
    ctx.io.print(
      "\nВстроенный SSH Windows спросит пароль на каждом шаге установки – удобнее вход по ключу (ssh-keygen, затем ключ на сервер).",
    );
    return;
  }
  control = mkdtempSync("/tmp/jssh-");
}
async function closeControl(ctx, a) {
  if (!control) return;
  if (a.sshHost)
    await ctx.exec("ssh", [...controlArgs(), "-O", "exit", dest(a)]);
  rmSync(control, { recursive: true, force: true });
  control = null;
}
const sshArgs = (a) => [
  ...controlArgs(),
  "-p",
  a.sshPort,
  ...keyArgs(a),
  "-o",
  "ConnectTimeout=15",
];
const dest = (a) => `${a.sshUser}@${a.sshHost}`;
// Команда на сервере. Всё, что в неё подставляется, прошло проверки выше
// (папка, домен, ID сотрудника) – кавычки оболочки сервера не нужны.
export const ssh = (ctx, a, command, opts = {}) =>
  ctx.exec("ssh", [...sshArgs(a), dest(a), command], opts);
const sshMust = async (ctx, a, command, message, opts) => {
  const r = await ssh(ctx, a, command, opts);
  if (r.code !== 0)
    stop(
      message +
        (r.stderr
          ? "\n" + r.stderr.trim().split("\n").slice(-5).join("\n")
          : ""),
    );
  return r;
};
const inDir = (a, command) => `cd ${a.remoteDir} && ${command}`;
// Папки данных на сервере: относительные – от папки журнала.
const remotePath = (a, dir) =>
  dir.startsWith("/") ? dir : path.posix.join(a.remoteDir, dir);

async function checkServer(ctx, a) {
  ctx.io.print("\n== Проверка сервера");
  const hello = await ssh(ctx, a, "uname -s");
  if (hello.code !== 0)
    stop(
      `Нет доступа к ${dest(a)} по SSH (порт ${a.sshPort}). Проверьте адрес, пользователя и ключ.` +
        (hello.stderr ? "\n" + hello.stderr.trim() : ""),
    );
  if (hello.stdout.trim() !== "Linux")
    stop(
      "На сервере не Linux: удалённо журнал ставится только на Linux с Docker.",
    );
  if ((await ssh(ctx, a, "docker compose version")).code !== 0)
    stop("На сервере нет Docker с плагином Compose v2.");
  if ((await ssh(ctx, a, "docker info")).code !== 0)
    stop(
      `У пользователя ${a.sshUser} нет доступа к Docker на сервере (добавьте его в группу docker).`,
    );
}

async function remoteExisting(ctx, a) {
  const r = await ssh(
    ctx,
    a,
    `test -f ${a.remoteDir}/.env || test -f ${a.remoteDir}/data/attendance.sqlite`,
  );
  return r.code === 0;
}

async function checkRemotePorts(ctx, a) {
  const r = await ssh(
    ctx,
    a,
    "(ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | grep -E '[:.](80|443)[[:space:]]'",
  );
  if (r.code === 0)
    stop(
      "На сервере заняты порты 80 или 443. Освободите их или выберите «Свой прокси сервера».",
    );
}

// Архив только из файлов приложения: git archive (закоммиченная версия),
// а без git – tar; список один и тот же.
export const APP_FILES = [
  "src",
  "public",
  "scripts",
  "deploy",
  "package.json",
  "package-lock.json",
  "Dockerfile",
  ".dockerignore",
  "compose.yaml",
  ".env.example",
];
async function makeArchive(ctx) {
  const dir = mkdtempSync(path.join(tmpdir(), "journal-"));
  const file = path.join(dir, "journal.tar.gz");
  if (existsSync(path.join(ctx.cwd, ".git")))
    await must(
      ctx.exec,
      "git",
      // Только файлы приложения: data/.gitkeep и прочее из репозитория на сервер
      // не едет – папки данных там принадлежат пользователю контейнера.
      ["archive", "--format=tar.gz", "-o", file, "HEAD", "--", ...APP_FILES],
      "Не удалось собрать архив (git archive).",
      { cwd: ctx.cwd },
    );
  else
    await must(
      ctx.exec,
      "tar",
      [
        "-czf",
        file,
        "-C",
        ctx.cwd,
        ...APP_FILES.filter((f) => existsSync(path.join(ctx.cwd, f))),
      ],
      "Не удалось собрать архив (tar).",
    );
  return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function uploadCode(ctx, a) {
  const archive = await makeArchive(ctx);
  const remoteTmp = `/tmp/journal-${stamp()}.tar.gz`;
  try {
    ctx.io.print("\n== Код на сервер");
    await must(
      ctx.exec,
      "scp",
      [
        ...controlArgs(),
        "-P",
        a.sshPort,
        ...keyArgs(a),
        archive.file,
        `${dest(a)}:${remoteTmp}`,
      ],
      "Не удалось скопировать архив на сервер (scp).",
    );
  } finally {
    archive.cleanup();
  }
  await sshMust(
    ctx,
    a,
    `mkdir -p ${a.remoteDir} && tar -xzf ${remoteTmp} -C ${a.remoteDir} && rm -f ${remoteTmp}`,
    "Не удалось распаковать код на сервере.",
  );
}

const remoteLogs = (ctx, a) =>
  ssh(ctx, a, inDir(a, "docker compose logs --tail=50 app"));
function failWithLogs(ctx, logs, message) {
  ctx.io.print(logs.stdout || logs.stderr || "");
  stop(
    message +
      " Последние строки журнала – выше; .env и данные на сервере сохранены, ничего не удалено.",
  );
}

// Статус проверки Compose (каждые 10 секунд после 20 секунд запуска);
// 120 секунд ожидания – несколько проверок даже при медленном старте.
async function waitRemoteHealthy(ctx, a) {
  ctx.io.print("Жду ответа журнала…");
  for (let t = 0; t < 120; t += 2) {
    const r = await ssh(
      ctx,
      a,
      inDir(a, "docker compose ps --format '{{.Health}}' app"),
    );
    if (r.stdout.trim() === "healthy") return;
    await ctx.sleep(2000);
  }
  failWithLogs(
    ctx,
    await remoteLogs(ctx, a),
    "Журнал на сервере не стал здоровым за 2 минуты.",
  );
}

async function startRemote(ctx, a) {
  ctx.io.print("\n== Проверка и запуск на сервере");
  await sshMust(
    ctx,
    a,
    inDir(a, "docker compose config --quiet"),
    "Ошибка в compose.yaml или .env на сервере.",
  );
  const up = await ssh(ctx, a, inDir(a, "docker compose up -d --build"), {
    inherit: true,
  });
  if (up.code !== 0)
    failWithLogs(
      ctx,
      await remoteLogs(ctx, a),
      "Не удалось собрать или запустить контейнеры на сервере.",
    );
  await waitRemoteHealthy(ctx, a);
}

export async function installRemote(ctx, a) {
  for (const d of [a.dataDir, a.backupsDir, a.uploadsDir].map((x) =>
    remotePath(a, x),
  ))
    if (!DIR_RE.test(d))
      stop(
        `Путь «${d}» на сервере: допустимы только латиница, цифры и . _ - /`,
      );
  if (a.proxy === "caddy" && !a.reconfiguring) await checkRemotePorts(ctx, a);
  await uploadCode(ctx, a);
  ctx.io.print("\n== Настройки и папки на сервере");
  const env = buildEnv(
    readFileSync(path.join(ctx.cwd, ".env.example"), "utf8"),
    envValues(a),
  );
  // .env идёт через стандартный ввод SSH: без временного файла и без аргументов.
  await sshMust(
    ctx,
    a,
    `if [ -f ${a.remoteDir}/.env ]; then cp -p ${a.remoteDir}/.env ${a.remoteDir}/.env.bak.${stamp()}; fi`,
    "Не удалось сохранить копию .env на сервере.",
  );
  await sshMust(
    ctx,
    a,
    `umask 077 && cat > ${a.remoteDir}/.env`,
    "Не удалось записать .env на сервере.",
    { input: env },
  );
  const dirs = [a.dataDir, a.backupsDir, a.uploadsDir].map((d) =>
    remotePath(a, d),
  );
  // Владелец папок – пользователь контейнера (UID 1000); chown – через Docker, без sudo.
  await sshMust(
    ctx,
    a,
    `mkdir -p ${dirs.join(" ")} && docker run --rm ${dirs.map((d, i) => `-v ${d}:/d${i}`).join(" ")} node:24-bookworm-slim sh -c 'chown -R 1000:1000 /d0 /d1 /d2 && chmod 700 /d0 /d1 /d2'`,
    "Не удалось подготовить папки данных на сервере.",
  );
  await startRemote(ctx, a);
}

export async function updateRemote(ctx, a) {
  const envText = (
    await sshMust(
      ctx,
      a,
      `cat ${a.remoteDir}/.env`,
      "Не удалось прочитать .env на сервере.",
    )
  ).stdout;
  const env = parseEnv(envText);
  a.domain = env.DOMAIN;
  const dataDir = remotePath(a, env.DATA_DIR || "data");
  if (!DIR_RE.test(dataDir))
    stop("Путь к базе в .env сервера содержит недопустимые символы.");
  // Код уезжает до остановки: сбой копирования оставляет журнал работающим.
  await uploadCode(ctx, a);
  ctx.io.print("\n== Остановка и копия базы на сервере");
  await sshMust(
    ctx,
    a,
    inDir(a, "docker compose stop app"),
    "Не удалось остановить журнал на сервере.",
  );
  const db = `${dataDir}/attendance.sqlite`;
  await sshMust(
    ctx,
    a,
    `if [ -f ${db} ]; then cp -p ${db} ${dataDir}/attendance.before-update-${stamp()}.sqlite && echo "Копия базы снята"; else echo "Базы ещё нет"; fi`,
    "Не удалось снять копию базы на сервере.",
  );
  await startRemote(ctx, a);
  ctx.io.print(
    "\nОбновление готово: .env, база, сканы и резервные копии на сервере не менялись.",
  );
}

async function confirmReconfigure(ctx, a) {
  if (
    await confirm(
      ctx.io,
      "Заполнить настройки на сервере заново? Прежний .env сохранится копией, база и сканы не меняются.",
    )
  )
    return true;
  ctx.io.print("Ничего не изменено.");
  return false;
}

// Серверный скрипт журнала внутри контейнера на сервере.
export const remoteAppScript = (ctx, a, script, args = []) =>
  ssh(
    ctx,
    a,
    inDir(
      a,
      `docker compose exec -T app node scripts/${script} ${args.join(" ")}`.trim(),
    ),
  );

// Сценарий удалённой установки целиком: вопросы о сервере, проверки,
// прежняя установка или новая, запуск.
// Этапы: вопросы о сервере с проверками, затем остальное. «<» на первом
// вопросе о сервере – назад к «куда ставить» (BACK), на первом вопросе
// второго этапа – к вопросам о сервере с прежними ответами.
export async function remoteFlow(ctx, a, options) {
  openControl(ctx);
  try {
    return await remoteSteps(ctx, a, options);
  } finally {
    await closeControl(ctx, a);
  }
}
async function remoteSteps(ctx, a, { finish, fixed }) {
  const { io } = ctx;
  let existing;
  for (;;) {
    if (!(await askSteps(io, REMOTE_STEPS, a, { fixed, back: true })))
      return BACK;
    a.method = "docker";
    await checkServer(ctx, a);
    existing = await remoteExisting(ctx, a);
    if (existing && !ctx.preset.reconfigure) break;
    if (existing && !(await confirmReconfigure(ctx, a))) return 0;
    if (existing) a.onExistingData = a.reconfiguring = true;
    if (await askSteps(io, STEPS.slice(2), a, { fixed, back: true })) break;
  }
  if (existing && !ctx.preset.reconfigure) {
    io.print(`\nНа сервере в ${a.remoteDir} уже установлен журнал.`);
    const pick = await askSteps(
      io,
      [UPDATE_STEP],
      ctx.preset.update ? { action: "update" } : {},
    );
    if (pick.action !== "update") {
      io.print("Ничего не изменено.");
      return 0;
    }
    await updateRemote(ctx, a);
    return 0;
  }
  if (a.auth === "shared") a.passwordHash = await askSharedPassword(io);
  io.print("\n" + summary(a));
  if (!(await confirm(io, "Установить?"))) {
    io.print("Отменено, ничего не изменено.");
    return 0;
  }
  await installRemote(ctx, a);
  io.print("Журнал на сервере работает.");
  await finish(a);
  return 0;
}
