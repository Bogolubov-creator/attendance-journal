// Запуск установщика: настоящий ввод, команды и сеть для ядра (core.mjs).
// Вызывается обёртками install.sh / install.bat из корня журнала.
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import http from "node:http";
import https from "node:https";
import { userInfo } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runInstaller } from "./core.mjs";

// Ответы читаются по строкам по порядку: так не теряются строки, пришедшие
// раньше вопроса (ввод из файла или конвейера). Конец ввода – отмена.
// Эхо идёт через out: на время ввода пароля оно выключается.
let muted = false;
const out = new Writable({
  write(chunk, encoding, done) {
    if (!muted) process.stdout.write(chunk);
    done();
  },
});
const rl = createInterface({
  input: process.stdin,
  output: out,
  terminal: Boolean(process.stdin.isTTY),
});
const lines = rl[Symbol.asyncIterator]();
async function nextLine(prompt) {
  process.stdout.write(prompt + " ");
  const { value, done } = await lines.next();
  if (done) {
    console.log("\nВвод закончился – установка прервана.");
    process.exit(1);
  }
  return value;
}
const io = {
  print: (text) => console.log(text),
  ask: (prompt) => nextLine(prompt),
  askSecret: async (prompt) => {
    muted = true;
    try {
      return await nextLine(prompt);
    } finally {
      muted = false;
      process.stdout.write("\n");
    }
  },
};

// Команда без оболочки: аргументы передаются как есть, подстановок нет.
// inherit – вывод сразу на экран (долгие команды вроде сборки образа).
function exec(cmd, args, { cwd, input, inherit } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, {
        cwd,
        stdio: [
          input === undefined ? "inherit" : "pipe",
          inherit ? "inherit" : "pipe",
          inherit ? "inherit" : "pipe",
        ],
        windowsHide: true,
      });
    } catch (e) {
      return resolve({ code: 127, stdout: "", stderr: String(e.message) });
    }
    let stdout = "",
      stderr = "";
    child.stdout?.on("data", (d) => (stdout += d));
    child.stderr?.on("data", (d) => (stderr += d));
    child.on("error", (e) =>
      resolve({ code: 127, stdout, stderr: String(e.message) }),
    );
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    if (input !== undefined) child.stdin.end(input);
  });
}

const net = {
  // Порт свободен, если на него никто не отвечает (занимать порт 80 без root нельзя).
  portFree: (port) =>
    new Promise((resolve) => {
      const s = connect({ host: "127.0.0.1", port });
      s.setTimeout(1500);
      s.on("connect", () => (s.destroy(), resolve(false)));
      s.on("error", () => resolve(true));
      s.on("timeout", () => (s.destroy(), resolve(true)));
    }),
  // Код ответа или 0, если не ответил.
  get: (url, { host, timeout = 3000 } = {}) =>
    new Promise((resolve) => {
      const lib = url.startsWith("https:") ? https : http;
      const req = lib.get(
        url,
        { headers: host ? { host } : {}, timeout },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on("timeout", () => req.destroy());
      req.on("error", () => resolve(0));
    }),
};

const flags = new Set(process.argv.slice(2));
const preset = {};
if (flags.has("--docker"))
  Object.assign(preset, { target: "local", method: "docker" });
if (flags.has("--native"))
  Object.assign(preset, { target: "local", method: "native" });

const code = await runInstaller({
  io,
  exec,
  net,
  preset,
  cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
  platform: process.platform,
  user: userInfo().username,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
});
rl.close();
process.exit(code);
