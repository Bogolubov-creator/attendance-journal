// Личные учётные записи сотрудников: логин, пароль, код приглашения.
// Пароли и коды приглашения хранятся только хешами scrypt с солью.
import {
  randomInt,
  randomBytes,
  createHash,
  scrypt,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import {
  passwordHash,
  passwordHashAsync,
  verifyPasswordAsync,
} from "./management-auth.js";
import { promisify } from "node:util";
import { managers } from "./office.js";

export const INVITE_DAYS = 7;
const MIN_PASSWORD = 10;
export const LOCK_MINUTES = 15;
const LOCK_AFTER = 5,
  LOCK_MS = LOCK_MINUTES * 60000;
const BAD_CODE = {
  status: 403,
  error:
    "Код не подходит или истёк – попросите новый у менеджера своей программы",
};
const TOO_MANY = {
  status: 429,
  error: `Слишком много попыток. Повторите через ${LOCK_MINUTES} минут.`,
};

function ensureStaffAccounts(db) {
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
  // Знакомые устройства (подход OWASP device cookie): где сотрудник уже
  // успешно входил, чужая блокировка учётной записи его не останавливает.
  db.exec(`CREATE TABLE IF NOT EXISTS staff_devices(
    tokenHash TEXT NOT NULL,
    personId TEXT NOT NULL,
    failures INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL,
    PRIMARY KEY(tokenHash, personId))`);
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
const scryptAsync = promisify(scrypt);
const codeMatches = async (code, hash) => {
  const m = /^s1024:([a-f0-9]{32}):([a-f0-9]{64})$/.exec(hash || "");
  if (!m) return false;
  const key = await scryptAsync(
    normalizeCode(code),
    Buffer.from(m[1], "hex"),
    32,
    { N: CODE_COST },
  );
  return timingSafeEqual(key, Buffer.from(m[2], "hex"));
};

// Проверки паролей и кодов без входа: не больше 4 одновременно (по числу
// потоков пула) и не больше 16 в очереди, остальным сразу «сервер занят».
// Иначе поток запросов на вход с любыми логинами занял бы сервер целиком.
const GATE_RUNNING = 4,
  GATE_WAITING = 16;
let running = 0;
const waiting = [];
export async function hashGate(fn) {
  if (running >= GATE_RUNNING) {
    if (waiting.length >= GATE_WAITING)
      throw Object.assign(
        new Error("Сервер занят, повторите вход через минуту"),
        { status: 429 },
      );
    // Место передаётся из finally напрямую, счётчик running не меняется.
    await new Promise((resolve) => waiting.push(resolve));
  } else running++;
  try {
    return await fn();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else running--;
  }
}

// Распространённые пароли не короче 10 символов (короче и так не пройдут):
// последовательности цифр и клавиш, «password», годы, имя вуза и журнала.
const common = new Set(
  `1234567890 0123456789 0987654321 1234512345 1111111111 0000000000
  1212121212 1122334455 9876543210 1234567891 12345678910 123456789a
  a123456789 1234567890a 1q2w3e4r5t 1q2w3e4r5t6y 1qaz2wsx3edc 123qweasdzxc
  qwertyuiop qwertyuiop1 qwerty1234 qwerty12345 qwerty123456 qwertyqwerty
  asdfghjkl1 asdfghjkl12 zxcvbnm123 zxcvbnm1234 qazwsxedcrfv 1qazxsw23edc
  password12 password123 password1! passw0rd12 password2024 password2025
  password2026 passwordpassword iloveyou12 iloveyou123 abc1234567 abcdefghij
  abcdefg123 aaaaaaaaaa zzzzzzzzzz 123123123123 123321123321 111222333444
  welcome123 welcome2025 welcome2026 letmein123 sunshine12 football12
  football123 princess12 monkey1234 dragon1234 master1234 superman12
  baseball12 trustno1trustno1 changeme12 administrator admin12345 admin123456
  qwerty2025 qwerty2026 йцукенгшщз йцукенгшщзх пароль1234 пароль12345
  парольпароль 1234567890q q1234567890 hse1234567 hsehsehse1 vshe123456
  vshe2026vshe vyshkavyshka vysshayashkola pravo12345 pravopravo pravohse2026
  journal123 zhurnal123 zhurnal2026 student123 student2026 teacher123
  teacher2026 prepod1234 prepodavatel moskva2026 moscow2026 russia2026
  rossiya2026 september2026 sentyabr2026 1234qwerasdf asdf1234asdf`
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
  // Счётчик читается из базы после ожидания хеша: параллельные неверные
  // попытки считаются все.
  function recordFailure(personId, now) {
    run(
      "UPDATE staff_accounts SET failures=failures+1 WHERE personId=?",
      personId,
    );
    if (byPerson(personId).failures >= LOCK_AFTER)
      run(
        "UPDATE staff_accounts SET failures=0, lockedUntil=? WHERE personId=?",
        now + LOCK_MS,
        personId,
      );
  }
  // Первый вход по коду: задаёт пароль, гасит код, увеличивает версию пароля.
  // Возвращает { account } или { error, status }.
  async function redeemInvite(login, code, password, now = Date.now()) {
    // Неверный код в счётчик блокировки не идёт: код около 59 бит онлайн не
    // подобрать, а счётчик позволил бы любому закрыть вход по чужому логину.
    const a = byLogin(login);
    const valid =
      a?.inviteHash &&
      a.inviteExpires > now &&
      (await hashGate(() => codeMatches(code, a.inviteHash)));
    if (!valid) return BAD_CODE;
    const problem = passwordProblem(password);
    if (problem) return { status: 400, error: problem };
    const hash = await hashGate(() => passwordHashAsync(password));
    // Код гасится условием на прежний хеш: два одновременных запроса
    // с одним кодом зададут пароль только один раз.
    const { changes } = run(
      "UPDATE staff_accounts SET passwordHash=?, inviteHash=NULL, inviteExpires=NULL, failures=0, lockedUntil=0, lastLoginAt=?, passwordVersion=passwordVersion+1 WHERE personId=? AND inviteHash=?",
      hash,
      new Date(now).toISOString(),
      a.personId,
      a.inviteHash,
    );
    if (!changes) return BAD_CODE;
    return { account: byPerson(a.personId) };
  }
  const deviceHash = (token) =>
    createHash("sha256").update(token).digest("hex");
  const deviceOf = (token, personId) =>
    typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token)
      ? get(
          "SELECT * FROM staff_devices WHERE tokenHash=? AND personId=?",
          deviceHash(token),
          personId,
        )
      : undefined;
  // Запомнить устройство после успешного входа; счётчик его ошибок обнуляется.
  function rememberDevice(token, personId, now = Date.now()) {
    run(
      "INSERT INTO staff_devices VALUES(?,?,0,?) ON CONFLICT(tokenHash, personId) DO UPDATE SET failures=0",
      deviceHash(token),
      personId,
      new Date(now).toISOString(),
    );
  }
  // Ошибка со знакомого устройства идёт в его собственный счётчик:
  // после 5 подряд отметка перестаёт действовать.
  function deviceFailure(device) {
    run(
      "UPDATE staff_devices SET failures=failures+1 WHERE tokenHash=? AND personId=?",
      device.tokenHash,
      device.personId,
    );
    run(
      "DELETE FROM staff_devices WHERE tokenHash=? AND personId=? AND failures>=?",
      device.tokenHash,
      device.personId,
      LOCK_AFTER,
    );
  }
  // Вход по логину и паролю. Несуществующий логин проверяется против
  // пустышки, чтобы время ответа не выдавало, есть ли такой логин.
  // С устройства, где сотрудник уже входил, блокировка учётной записи не
  // действует, а ошибки идут в счётчик устройства.
  // Возвращает { account }, { locked: true } или {} при неверной паре.
  async function checkPassword(login, password, device, now = Date.now()) {
    const a = byLogin(login);
    const known = a && deviceOf(device, a.personId);
    if (a && !known && locked(a, now)) return { locked: true };
    const ok = await hashGate(() =>
      verifyPasswordAsync(password, a?.passwordHash || DUMMY_HASH),
    );
    if (!a?.passwordHash || !ok) {
      // У приглашённого без пароля неверные входы не считаем: иначе любой
      // закрыл бы ему «Первый вход», зная предсказуемый логин.
      if (known) deviceFailure(known);
      else if (a?.passwordHash) recordFailure(a.personId, now);
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
  async function changePassword(personId, current, next, now = Date.now()) {
    const a = byPerson(personId);
    if (!a?.passwordHash) return { status: 403, error: "Нет личного пароля" };
    if (locked(a, now)) return TOO_MANY;
    if (!(await hashGate(() => verifyPasswordAsync(current, a.passwordHash)))) {
      recordFailure(personId, now);
      return { status: 403, error: "Текущий пароль указан неверно" };
    }
    const problem = passwordProblem(next);
    if (problem) return { status: 400, error: problem };
    const hash = await hashGate(() => passwordHashAsync(next));
    const { changes } = run(
      "UPDATE staff_accounts SET passwordHash=?, failures=0, lockedUntil=0, passwordVersion=passwordVersion+1 WHERE personId=? AND passwordVersion=?",
      hash,
      personId,
      a.passwordVersion,
    );
    if (!changes)
      return { status: 409, error: "Пароль уже изменён. Войдите заново" };
    return { account: byPerson(personId) };
  }
  // Сброс: прежний пароль гаснет, версия растёт – все сессии человека закрываются.
  function resetPassword(personId) {
    run(
      "UPDATE staff_accounts SET passwordHash=NULL, failures=0, lockedUntil=0, passwordVersion=passwordVersion+1 WHERE personId=?",
      personId,
    );
    run("DELETE FROM staff_devices WHERE personId=?", personId);
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
  const remove = (personId) => {
    run("DELETE FROM staff_accounts WHERE personId=?", personId);
    run("DELETE FROM staff_devices WHERE personId=?", personId);
  };
  return {
    byPerson,
    issueInvite,
    redeemInvite,
    checkPassword,
    rememberDevice,
    changePassword,
    resetPassword,
    accessState,
    expireInvites,
    remove,
    personalOnly,
    enablePersonalOnly,
  };
}
