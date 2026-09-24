// Снимает режим «только личные пароли»: снова работает вход выбором из списка
// с общим паролем. Кнопки для этого в журнале нет намеренно – чтобы защиту
// не откатили случайно. Сервер можно не останавливать.
//   node scripts/allow-shared-password.mjs
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
const { changes } = db
  .prepare("DELETE FROM service_state WHERE key='personalOnly'")
  .run();
if (changes)
  db.prepare(
    "INSERT INTO audit(actor,role,action,entity,label,at) VALUES(?,?,?,?,?,?)",
  ).run(
    "Серверный скрипт",
    "server",
    "access.mode",
    "access",
    "вход по общему паролю снова разрешён",
    new Date().toISOString(),
  );
db.close();
process.stdout.write(
  changes
    ? "Режим «только личные пароли» снят: общий пароль снова действует.\n"
    : "Режим «только личные пароли» не был включён.\n",
);
