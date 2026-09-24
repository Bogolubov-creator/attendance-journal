// Личные учётные записи сотрудников: логин, пароль, код приглашения.
// Пароли и коды приглашения хранятся только хешами scrypt с солью.
import {
  randomInt,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { passwordHash, verifyPassword } from "./management-auth.js";
import { managers } from "./office.js";

export const INVITE_DAYS = 7;
export const MIN_PASSWORD = 10;
const LOCK_AFTER = 5,
  LOCK_MS = 15 * 60000;
const TOO_MANY = {
  status: 429,
  error: "Слишком много попыток. Повторите через 15 минут.",
};

export function ensureStaffAccounts(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS staff_accounts(
    personId TEXT PRIMARY KEY,
    login TEXT NOT NULL UNIQUE COLLATE NOCASE,
    passwordHash TEXT,
    inviteHash TEXT,
    inviteExpires INTEGER,
    failures INTEGER NOT NULL DEFAULT 0,
    lockedUntil INTEGER NOT NULL DEFAULT 0,
    lastLoginAt TEXT,
    passwordVersion INTEGER NOT NULL DEFAULT 0)`);
}

// Сотрудник по ID: сначала справочник учебного офиса, затем реестр преподавателей.
// Пересечений между ними нет, поэтому роль определяется местом, где человек найден.
export function findPerson(personId, roster) {
  const m = managers.find((x) => x.id === personId);
  if (m) return { id: m.id, name: m.name, role: m.role };
  const t = roster.teachers.find((x) => x.id === personId);
  return t ? { id: t.id, name: t.name, role: "teacher" } : null;
}

// ГОСТ 7.79, система Б, без диакритики – достаточно для логина.
const letters = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  е: "e",
  ё: "e",
  ж: "zh",
  з: "z",
  и: "i",
  й: "j",
  к: "k",
  л: "l",
  м: "m",
  н: "n",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  у: "u",
  ф: "f",
  х: "x",
  ц: "c",
  ч: "ch",
  ш: "sh",
  щ: "shh",
  ъ: "",
  ы: "y",
  ь: "",
  э: "e",
  ю: "yu",
  я: "ya",
};
const translit = (s) =>
  [...s.toLocaleLowerCase("ru")]
    .map((ch) => letters[ch] ?? (/[a-z0-9]/.test(ch) ? ch : ""))
    .join("");

// «Вак_Иванов Иван Иванович» → ivanov.ii; занятый логин получает цифру 2, 3…
export function makeLogin(name, taken) {
  const [surname = "", ...rest] = name.replace(/^Вак_/, "").trim().split(/\s+/);
  const base =
    (translit(surname) || "user") +
    "." +
    rest.map((p) => translit(p).slice(0, 1)).join("");
  const stem = base.endsWith(".") ? base.slice(0, -1) : base;
  if (!taken(stem)) return stem;
  for (let n = 2; ; n++) if (!taken(stem + n)) return stem + n;
}

// Без похожих знаков: нет 0/O, 1/I/L.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export function newInviteCode() {
  const raw = Array.from(
    { length: 12 },
    () => ALPHABET[randomInt(ALPHABET.length)],
  ).join("");
  return raw.match(/.{4}/g).join("-");
}
const normalizeCode = (code) =>
  String(code || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
// Код случайный (12 знаков из 31, около 59 бит) и живёт 7 дней. Хеш – scrypt
// с собственной солью, но с малой ценой (N=1024, около 7 мс): соль не даёт
// перебирать по копии базы все коды разом, а выгрузка сотен кодов не
// останавливает сервер. Пароли хешируются с полной ценой (management-auth.js).
const CODE_COST = 1024;
const codeHash = (code) => {
  const salt = randomBytes(16);
  const key = scryptSync(normalizeCode(code), salt, 32, { N: CODE_COST });
  return `s${CODE_COST}:${salt.toString("hex")}:${key.toString("hex")}`;
};
const codeMatches = (code, hash) => {
  const m = /^s1024:([a-f0-9]{32}):([a-f0-9]{64})$/.exec(hash || "");
  if (!m) return false;
  const key = scryptSync(normalizeCode(code), Buffer.from(m[1], "hex"), 32, {
    N: CODE_COST,
  });
  return timingSafeEqual(key, Buffer.from(m[2], "hex"));
};

const common = new Set(
  `1234567890 0123456789 0987654321 1234512345 1111111111 0000000000 1212121212
  qwertyuiop qwertyuiop1 qwerty1234 qwerty12345 1q2w3e4r5t 1qaz2wsx3edc zaq12wsx
  asdfghjkl1 asdfghjkl; zxcvbnm123 password12 password123 password1! passw0rd12
  iloveyou12 abc1234567 abcdefghij aaaaaaaaaa 123qweasdzxc 123123123123
  йцукенгшщз йцукенгшщзх пароль1234 пароль12345 1234567890q q1234567890
  hse1234567 hsehsehse1 vyshkavyshka vshe123456 vshe2026vshe administrator
  welcome123 welcome2026 letmein123 sunshine12 football12 princess12 monkey1234
  dragon1234 master1234 superman12 baseball12 trustno1trustno1 changeme12
  pravo12345 pravopravo journal123 zhurnal123 student123 teacher123 prepod1234`
    .split(/\s+/)
    .filter(Boolean),
);
// Возвращает текст ошибки или null, если пароль подходит.
export function passwordProblem(password) {
  if (typeof password !== "string" || password.length > 256)
    return "Некорректный пароль";
  if (password.length < MIN_PASSWORD)
    return `Пароль должен быть не короче ${MIN_PASSWORD} символов`;
  if (common.has(password.toLocaleLowerCase("ru")))
    return "Этот пароль слишком распространён, придумайте другой";
  return null;
}

const DUMMY_HASH = passwordHash("нет такой учётной записи");

export function staffAccounts(db) {
  ensureStaffAccounts(db);
  const get = (sql, ...a) => db.prepare(sql).get(...a),
    run = (sql, ...a) => db.prepare(sql).run(...a);
  const byLogin = (login) =>
    typeof login === "string" && login.length <= 100
      ? get("SELECT * FROM staff_accounts WHERE login=?", login.trim())
      : undefined;
  const byPerson = (personId) =>
    get("SELECT * FROM staff_accounts WHERE personId=?", personId);
  // Новый код заменяет прежний; логин создаётся при первой выдаче и дальше не меняется.
  function issueInvite(person, now = Date.now()) {
    const code = newInviteCode(),
      expires = now + INVITE_DAYS * 86400000;
    const existing = byPerson(person.id);
    if (existing)
      run(
        "UPDATE staff_accounts SET inviteHash=?, inviteExpires=? WHERE personId=?",
        codeHash(code),
        expires,
        person.id,
      );
    else
      run(
        "INSERT INTO staff_accounts(personId,login,inviteHash,inviteExpires) VALUES(?,?,?,?)",
        person.id,
        makeLogin(person.name, (l) => !!byLogin(l)),
        codeHash(code),
        expires,
      );
    return { login: byPerson(person.id).login, code, expires };
  }
  const locked = (a, now) => a.lockedUntil > now;
  function recordFailure(a, now) {
    const failures = a.failures + 1;
    run(
      "UPDATE staff_accounts SET failures=?, lockedUntil=? WHERE personId=?",
      failures >= LOCK_AFTER ? 0 : failures,
      failures >= LOCK_AFTER ? now + LOCK_MS : a.lockedUntil,
      a.personId,
    );
  }
  // Первый вход по коду: задаёт пароль, гасит код, увеличивает версию пароля.
  // Возвращает { account } или { error, status }.
  function redeemInvite(login, code, password, now = Date.now()) {
    const a = byLogin(login);
    if (a && locked(a, now)) return TOO_MANY;
    const valid =
      a?.inviteHash && a.inviteExpires > now && codeMatches(code, a.inviteHash);
    if (!valid) {
      if (a) recordFailure(a, now);
      return {
        status: 403,
        error:
          "Код не подходит или истёк – попросите новый у менеджера своей программы",
      };
    }
    const problem = passwordProblem(password);
    if (problem) return { status: 400, error: problem };
    run(
      "UPDATE staff_accounts SET passwordHash=?, inviteHash=NULL, inviteExpires=NULL, failures=0, lockedUntil=0, lastLoginAt=?, passwordVersion=passwordVersion+1 WHERE personId=?",
      passwordHash(password),
      new Date(now).toISOString(),
      a.personId,
    );
    return { account: byPerson(a.personId) };
  }
  // Вход по логину и паролю. Несуществующий логин проверяется против
  // пустышки, чтобы время ответа не выдавало, есть ли такой логин.
  // Возвращает { account }, { locked: true } или {} при неверной паре.
  function checkPassword(login, password, now = Date.now()) {
    const a = byLogin(login);
    if (a && locked(a, now)) return { locked: true };
    const ok = verifyPassword(password, a?.passwordHash || DUMMY_HASH);
    if (!a?.passwordHash || !ok) {
      // У приглашённого без пароля неверные входы не считаем: иначе любой
      // закрыл бы ему «Первый вход», зная предсказуемый логин.
      if (a?.passwordHash) recordFailure(a, now);
      return {};
    }
    run(
      "UPDATE staff_accounts SET failures=0, lockedUntil=0, lastLoginAt=? WHERE personId=?",
      new Date(now).toISOString(),
      a.personId,
    );
    return { account: byPerson(a.personId) };
  }
  // Смена своего пароля: неверный текущий пароль идёт в счётчик блокировки.
  // Возвращает { account } или { error, status }.
  function changePassword(personId, current, next, now = Date.now()) {
    const a = byPerson(personId);
    if (!a?.passwordHash) return { status: 403, error: "Нет личного пароля" };
    if (locked(a, now)) return TOO_MANY;
    if (!verifyPassword(current, a.passwordHash)) {
      recordFailure(a, now);
      return { status: 403, error: "Текущий пароль указан неверно" };
    }
    const problem = passwordProblem(next);
    if (problem) return { status: 400, error: problem };
    run(
      "UPDATE staff_accounts SET passwordHash=?, failures=0, lockedUntil=0, passwordVersion=passwordVersion+1 WHERE personId=?",
      passwordHash(next),
      personId,
    );
    return { account: byPerson(personId) };
  }
  // Сброс: прежний пароль гаснет, версия растёт – все сессии человека закрываются.
  function resetPassword(personId) {
    run(
      "UPDATE staff_accounts SET passwordHash=NULL, failures=0, lockedUntil=0, passwordVersion=passwordVersion+1 WHERE personId=?",
      personId,
    );
  }
  // Состояние для страницы «Сотрудники»: без хешей.
  function accessState(personId, now = Date.now()) {
    const a = byPerson(personId);
    if (a?.passwordHash)
      return { state: "active", login: a.login, lastLoginAt: a.lastLoginAt };
    if (a?.inviteHash && a.inviteExpires > now)
      return { state: "invited", login: a.login, expires: a.inviteExpires };
    return { state: "none", login: a?.login || null };
  }
  // Режим «только личные пароли» – флаг в служебном состоянии базы; снимается
  // только серверным скриптом.
  const personalOnly = () =>
    !!get("SELECT 1 FROM service_state WHERE key='personalOnly'");
  const enablePersonalOnly = (by) =>
    run(
      "INSERT OR REPLACE INTO service_state VALUES('personalOnly',?)",
      JSON.stringify({ at: new Date().toISOString(), by }),
    );
  // Перед массовой выгрузкой: гаснут все неиспользованные коды, в том числе
  // у тех, кто в новый файл не попадёт.
  const expireInvites = () =>
    run(
      "UPDATE staff_accounts SET inviteHash=NULL, inviteExpires=NULL WHERE passwordHash IS NULL",
    );
  const remove = (personId) =>
    run("DELETE FROM staff_accounts WHERE personId=?", personId);
  return {
    byLogin,
    byPerson,
    issueInvite,
    redeemInvite,
    checkPassword,
    changePassword,
    resetPassword,
    accessState,
    expireInvites,
    remove,
    personalOnly,
    enablePersonalOnly,
  };
}
