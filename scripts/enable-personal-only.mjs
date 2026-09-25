// Включает режим «только личные пароли» – как кнопка дня переключения, но с
// сервера: установщик вызывает его на свежей установке. Сервер можно не
// останавливать. Снять режим – scripts/allow-shared-password.mjs.
//   node scripts/enable-personal-only.mjs
// Путь к базе – DB_PATH, по умолчанию data/attendance.sqlite.
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";

const dbPath = process.env.DB_PATH || "data/attendance.sqlite";
if (!existsSync(dbPath)) {
  process.stderr.write(`База ${dbPath} не найдена\n`);
  process.exit(1);
}
const db = new DatabaseSync(dbPath);
db.exec("PRAGMA busy_timeout=5000");
const on = db
  .prepare("SELECT 1 FROM service_state WHERE key='personalOnly'")
  .get();
if (!on) {
  db.prepare("INSERT INTO service_state VALUES('personalOnly',?)").run(
    JSON.stringify({ at: new Date().toISOString(), by: "Серверный скрипт" }),
  );
  db.prepare(
    "INSERT INTO audit(actor,role,action,entity,label,at) VALUES(?,?,?,?,?,?)",
  ).run(
    "Серверный скрипт",
    "server",
    "access.mode",
    "access",
    "вход только по личным паролям (установка)",
    new Date().toISOString(),
  );
}
db.close();
process.stdout.write(
  on
    ? "Режим «только личные пароли» уже включён.\n"
    : "Включён вход только по личным паролям.\n",
);
