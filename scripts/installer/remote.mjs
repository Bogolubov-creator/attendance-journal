// Установка на удалённый Linux-сервер по SSH: только через Docker.
// Пароль SSH, если нужен, спрашивает сам ssh – установщик его не видит.
import { existsSync, rmSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  stop,
  run,
  must,
  askSteps,
  STEPS,
  buildEnv,
  envValues,
  summary,
  stamp,
  askSharedPassword,
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
      default: "-",
      check: (v) =>
        v === "-" || existsSync(v) ? null : "Файл ключа не найден",
    }),
  },
  {
    id: "remoteDir",
    ask: () => ({
      text: "Папка журнала на сервере",
      default: "/opt/attendance-journal",
      check: (v) =>
        DIR_RE.test(v)
          ? null
          : "Нужен абсолютный путь из латиницы, цифр, . _ - /",
    }),
  },
];

const sshArgs = (a) => [
  "-p",
  a.sshPort,
  ...(a.sshKey && a.sshKey !== "-" ? ["-i", a.sshKey] : []),
  "-o",
  "ConnectTimeout=15",
];
const dest = (a) => `${a.sshUser}@${a.sshHost}`;
// Команда на сервере. Всё, что в неё подставляется, прошло проверки выше
// (папка, домен, ID сотрудника) – кавычки оболочки сервера не нужны.
export const ssh = (ctx, a, command, opts = {}) =>
  run(ctx.exec, "ssh", [...sshArgs(a), dest(a), command], opts);
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
        "-P",
        a.sshPort,
        ...(a.sshKey && a.sshKey !== "-" ? ["-i", a.sshKey] : []),
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
  if (a.proxy === "caddy") await checkRemotePorts(ctx, a);
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
  const env = Object.fromEntries(
    envText
      .split(/\r?\n/)
      .map((l) => /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(l))
      .filter(Boolean)
      .map((m) => [m[1], m[2]]),
  );
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
export async function remoteFlow(ctx, a, { finish }) {
  const { io } = ctx;
  await askSteps(io, REMOTE_STEPS, a);
  a.method = "docker";
  await checkServer(ctx, a);
  const existing = await remoteExisting(ctx, a);
  if (existing && ctx.preset.reconfigure) {
    const sure = (
      await io.ask(
        "Заполнить настройки на сервере заново? Прежний .env сохранится копией, база и сканы не меняются. [д/н]",
      )
    ).trim();
    if (!/^[ДдYy]/.test(sure)) {
      io.print("Ничего не изменено.");
      return 0;
    }
    await sshMust(
      ctx,
      a,
      `if [ -f ${a.remoteDir}/.env ]; then cp -p ${a.remoteDir}/.env ${a.remoteDir}/.env.bak.${stamp()}; fi`,
      "Не удалось сохранить копию .env на сервере.",
    );
  } else if (existing) {
    io.print(`\nНа сервере в ${a.remoteDir} уже установлен журнал.`);
    const pick = await askSteps(
      io,
      [
        {
          id: "action",
          ask: () => ({
            text: "Что сделать?",
            help: "Обновить – копия базы, новый код и перезапуск; настройки, база, сканы и копии не меняются.",
            choices: [
              ["update", "Обновить"],
              ["exit", "Выйти, ничего не меняя"],
            ],
            default: "exit",
          }),
        },
      ],
      ctx.preset.update ? { action: "update" } : {},
    );
    if (pick.action !== "update") {
      io.print("Ничего не изменено.");
      return 0;
    }
    await updateRemote(ctx, a);
    return 0;
  }
  await askSteps(io, STEPS.slice(2), a);
  if (a.auth === "shared") a.passwordHash = await askSharedPassword(io);
  io.print("\n" + summary(a));
  const go = (await io.ask("Установить? [д/н]")).trim();
  if (!/^[ДдYy]/.test(go)) {
    io.print("Отменено, ничего не изменено.");
    return 0;
  }
  await installRemote(ctx, a);
  io.print("Журнал на сервере работает.");
  await finish(a);
  return 0;
}
