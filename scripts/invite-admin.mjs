// Первый доступ администратора журнала: код приглашения для сотрудника полного
// доступа из справочника src/office.js. Работает с файлом базы напрямую, сервер
// можно не останавливать. Код печатается один раз и в базе хранится только хешем.
//   node scripts/invite-admin.mjs gadzhieva
// Путь к базе – DB_PATH, по умолчанию data/attendance.sqlite.
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { managers } from "../src/office.js";
import { staffAccounts, INVITE_DAYS } from "../src/staff-accounts.js";

const id = process.argv[2];
const person = managers.find((m) => m.id === id);
if (!person || person.role !== "admin") {
  process.stderr.write(
    "Укажите ID сотрудника полного доступа: " +
      managers
        .filter((m) => m.role === "admin")
        .map((m) => m.id)
        .join(", ") +
      "\n",
  );
  process.exit(1);
}
const dbPath = process.env.DB_PATH || "data/attendance.sqlite";
if (!existsSync(dbPath)) {
  process.stderr.write(`База ${dbPath} не найдена\n`);
  process.exit(1);
}
const db = new DatabaseSync(dbPath);
db.exec("PRAGMA busy_timeout=5000");
const { login, code } = staffAccounts(db).issueInvite(person);
db.prepare(
  "INSERT INTO audit(actor,role,action,entity,label,at) VALUES(?,?,?,?,?,?)",
).run(
  "Серверный скрипт",
  "server",
  "access.invite",
  person.id,
  person.name,
  new Date().toISOString(),
);
db.close();
process.stdout.write(
  `${person.name}\nЛогин: ${login}\nКод приглашения: ${code}\n` +
    `Код действует ${INVITE_DAYS} дней. На экране входа – «Первый вход».\n`,
);
