import { csvCell } from "./csv.js";
import { registerDaily, attendanceRecords } from "./daily.js";
import { registerStudent } from "./student.js";
import { attachmentPath, attachmentLabel } from "./attachments.js";
import { verifyPassword } from "./management-auth.js";
import { parseRoster, planImport, applyImport } from "./roster-import.js";
import express from "express";
import {
  managers,
  programs,
  directorySource,
  managerFor,
  canEditStudent,
  canSeeStudent,
  procedureCatalog,
  procedureStates,
  procedureStatus,
  validDate,
  enrollmentStatuses,
  closedEnrollmentStatuses,
  studentFieldsError,
  studentFieldsValid,
} from "./office.js";
import { DatabaseSync } from "node:sqlite";
import {
  readFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { randomBytes, createHash } from "node:crypto";
import * as oidc from "openid-client";
import { backup } from "node:sqlite";
import path from "node:path";
import { moscowDate, ruCompare, studentMetrics, studentId } from "./domain.js";
const app = express(),
  port = Number(process.env.PORT || 3100),
  demo = process.env.DEMO_MODE === "true";
// На живых данных демо-режим не раскрывает студентов: ни списка ФИО, ни входа в их кабинет.
const demoStudentLogin = demo && process.env.DATA_MODE !== "live";
const selection =
  (process.env.AUTH_MODE || (demo ? "selection" : "oidc")) === "selection";
const origin = process.env.APP_ORIGIN || `http://127.0.0.1:${port}`;
if (!demo && !origin.startsWith("https://"))
  throw Error("В рабочем режиме нужен APP_ORIGIN с HTTPS");
// Реестр хранится в базе; в памяти лежит его копия, все правки идут через базу.
const roster = { students: [], teachers: [], enrollments: [], quality: {} };
mkdirSync("data", { recursive: true });
// Таблицы lessons и marks больше не пополняются: в них исторические отметки прежнего журнала по парам.
const db = new DatabaseSync(
  process.env.DB_PATH || `data/${demo ? "demo" : "attendance"}.sqlite`,
);
db.exec(
  `PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS lessons(id TEXT PRIMARY KEY,teacherId TEXT,data TEXT);CREATE TABLE IF NOT EXISTS marks(lessonId TEXT,studentId TEXT,status TEXT,note TEXT,updatedAt TEXT, PRIMARY KEY(lessonId,studentId)); CREATE TABLE IF NOT EXISTS debts(id TEXT PRIMARY KEY,studentId TEXT,title TEXT,resolved INTEGER DEFAULT 0,createdAt TEXT);CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,actor TEXT,action TEXT,entity TEXT,at TEXT); CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,data TEXT,expires INTEGER);`,
);
db.exec(
  "PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS service_state(key TEXT PRIMARY KEY,value TEXT);",
);
db.exec(`CREATE TABLE IF NOT EXISTS student_profiles(studentId TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS student_accounts(externalId TEXT PRIMARY KEY, studentId TEXT NOT NULL, linkedAt TEXT NOT NULL, linkedBy TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS procedures(studentId TEXT, kind TEXT, data TEXT NOT NULL, PRIMARY KEY(studentId,kind));
CREATE TABLE IF NOT EXISTS roster_additions(id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS roster_students(id TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS roster_teachers(id TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS roster_enrollments(studentId TEXT NOT NULL, teacherId TEXT NOT NULL, grp TEXT NOT NULL, course TEXT NOT NULL, kind TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS attachments(id TEXT PRIMARY KEY, studentId TEXT NOT NULL, kind TEXT NOT NULL, fileName TEXT NOT NULL, storedName TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, uploadedAt TEXT NOT NULL, uploadedBy TEXT NOT NULL);`);
// Куда складываются сканы студентов; читается один раз здесь, маршруты получают путь готовым.
const uploadDir = process.env.UPLOAD_DIR || "data/uploads";
const get = (sql, ...a) => db.prepare(sql).get(...a),
  all = (sql, ...a) => db.prepare(sql).all(...a),
  run = (sql, ...a) => db.prepare(sql).run(...a);
const token = () => randomBytes(32).toString("base64url"),
  hash = (s) => createHash("sha256").update(s).digest("hex");
const addEnrollment = (e) =>
  run(
    "INSERT INTO roster_enrollments VALUES(?,?,?,?,?)",
    e.studentId,
    e.teacherId,
    e.group,
    e.course,
    e.kind,
  );
// Первое наполнение пустой базы: файл импорта и прежние ручные добавления. Дальше файл не читается.
if (
  !get("SELECT 1 FROM roster_students") &&
  !get("SELECT 1 FROM roster_teachers")
) {
  const rosterPath = process.env.ROSTER_PATH || "data/roster.json";
  const file = existsSync(rosterPath)
    ? JSON.parse(readFileSync(rosterPath, "utf8"))
    : { students: [], teachers: [], enrollments: [], quality: {} };
  db.exec("BEGIN IMMEDIATE");
  for (const s of file.students)
    run("INSERT INTO roster_students VALUES(?,?)", s.id, s.name);
  for (const t of file.teachers)
    run("INSERT INTO roster_teachers VALUES(?,?)", t.id, t.name);
  file.enrollments.forEach(addEnrollment);
  for (const row of all("SELECT data FROM roster_additions")) {
    const a = JSON.parse(row.data);
    run("INSERT OR IGNORE INTO roster_students VALUES(?,?)", a.id, a.name);
    for (const l of a.links)
      addEnrollment({
        studentId: a.id,
        teacherId: l.teacherId,
        group: "",
        course: l.course,
        kind: "ручной ввод",
      });
  }
  run(
    "INSERT OR REPLACE INTO service_state VALUES('rosterQuality',?)",
    JSON.stringify(file.quality || {}),
  );
  db.exec("COMMIT");
}
roster.students = all("SELECT id,name FROM roster_students ORDER BY rowid");
roster.teachers = all("SELECT id,name FROM roster_teachers ORDER BY rowid");
roster.enrollments = all(
  "SELECT studentId,teacherId,grp AS 'group',course,kind FROM roster_enrollments ORDER BY rowid",
);
roster.quality = JSON.parse(
  get("SELECT value FROM service_state WHERE key='rosterQuality'")?.value ||
    "{}",
);
// Журнал изменений: кто, что и над чем; label – человекочитаемое описание для «Последних изменений».
if (!all("PRAGMA table_info(audit)").some((c) => c.name === "label"))
  db.exec(
    "ALTER TABLE audit ADD COLUMN role TEXT; ALTER TABLE audit ADD COLUMN label TEXT;",
  );
const audit = (u, action, entity, label = "") =>
  run(
    "INSERT INTO audit(actor,role,action,entity,label,at) VALUES(?,?,?,?,?,?)",
    u.email || u.name,
    u.role,
    action,
    entity,
    label,
    new Date().toISOString(),
  );
const registryActions = [
  "student.add",
  "student.rename",
  "student.delete",
  "teacher.add",
  "teacher.rename",
  "teacher.delete",
  "enrollment.add",
  "enrollment.delete",
  "roster.import",
  "year.rollover",
  "account.link",
  "account.unlink",
  "student.profile",
  "student.requirement",
  "attachment.add",
  "attachment.view",
  "attachment.delete",
];
let accounts = [];
try {
  accounts = JSON.parse(readFileSync("data/accounts.json", "utf8"));
} catch {}
if (!selection && (!demo || process.env.REQUIRE_AUTH_CONFIG === "true")) {
  if (
    !process.env.OIDC_ISSUER?.startsWith("https://") ||
    !process.env.OIDC_CLIENT_ID ||
    !process.env.OIDC_CLIENT_SECRET
  )
    throw Error(
      "Заполните параметры университетской авторизации до запуска сервера",
    );
  if (
    !accounts.some(
      (a) =>
        a.role === "admin" && a.subject && /^[^\s@]+@hse\.ru$/.test(a.email),
    )
  )
    throw Error(
      "Укажите подтверждённую административную учётку в data/accounts.json",
    );
}
const fail = (code, message) =>
  Object.assign(new Error(message), { status: code });
app.disable("x-powered-by");
// За обратным прокси адрес посетителя приходит в X-Forwarded-For.
// TRUST_PROXY – число своих прокси перед приложением; без него считается адрес соединения.
if (process.env.TRUST_PROXY)
  app.set("trust proxy", Number(process.env.TRUST_PROXY));
app.use((req, res, next) => {
  if (req.headers.host !== new URL(origin).host)
    return res.status(403).json({ error: "Недопустимый адрес сервера" });
  res.set({
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "Content-Security-Policy":
      "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  });
  if (
    !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
    req.headers.origin !== origin
  )
    return res.status(403).json({ error: "Запрос с другого сайта отклонён" });
  next();
});
app.use(express.json({ limit: "256kb" }));
const managementHash = process.env.MANAGEMENT_PASSWORD_HASH || "";
const managementVersion = hash(managementHash);
const loginAttempts = new Map();
// Время неверных попыток со всех адресов за последние 15 минут (не больше 30).
let passwordFailures = [];
function checkManagementPassword(req) {
  if (!managementHash) throw fail(503, "Пароль ещё не настроен");
  const now = Date.now();
  for (const [key, value] of loginAttempts)
    if (value.until <= now) loginAttempts.delete(key);
  passwordFailures = passwordFailures.filter((t) => t > now - 15 * 60000);
  const key = req.ip;
  const attempt = loginAttempts.get(key) || {
    count: 0,
    until: now + 15 * 60000,
  };
  if (attempt.count >= 5 || passwordFailures.length >= 30)
    throw fail(429, "Слишком много попыток. Повторите через 15 минут.");
  if (!verifyPassword(req.body.password, managementHash)) {
    attempt.count++;
    passwordFailures.push(now);
    loginAttempts.set(key, attempt);
    throw fail(403, "Неверный пароль");
  }
  loginAttempts.delete(key);
}
app.use((req, res, next) => {
  const id = req.headers.cookie
    ?.split("; ")
    .find((x) => x.startsWith("journal="))
    ?.slice(8);
  const row =
    id &&
    get(
      "SELECT * FROM sessions WHERE id=? AND expires>?",
      hash(id),
      Date.now(),
    );
  req.session = row ? JSON.parse(row.data) : null;
  req.sessionKey = row?.id;
  // Любая сессия, кроме университетского входа, выдана по общему паролю
  // и закрывается при его смене.
  if (
    req.session?.user &&
    !["oidc", "explicit"].includes(req.session.user.source) &&
    (!managementHash || req.session.managementVersion !== managementVersion)
  ) {
    run("DELETE FROM sessions WHERE id=?", req.sessionKey);
    req.session = null;
  }

  if (req.session?.user?.role === "student") {
    const u = req.session.user;
    const valid =
      cabinetOpen(u.studentId) &&
      (u.source === "demo"
        ? demoStudentLogin
        : studentByExternalId(u.subject) === u.studentId);
    if (!valid) {
      run("DELETE FROM sessions WHERE id=?", req.sessionKey);
      req.session = null;
    }
  } else if (selection && req.session?.user?.source === "selection") {
    const u = req.session.user;
    const valid =
      u.role === "teacher"
        ? roster.teachers.some((t) => t.id === u.id)
        : managers.some((m) => m.id === u.id && m.role === u.role);
    if (!valid) {
      run("DELETE FROM sessions WHERE id=?", req.sessionKey);
      req.session = null;
    }
  } else if (!demo && req.session?.user) {
    const u = req.session.user;
    const valid = accounts.some(
      (a) =>
        a.subject === u.subject &&
        a.email.toLowerCase() === u.email &&
        a.role === u.role &&
        (u.role === "admin" || a.teacherId === u.id),
    );
    if (!valid) {
      run("DELETE FROM sessions WHERE id=?", req.sessionKey);
      req.session = null;
    }
  }
  next();
});
function session(res, data) {
  const id = token();
  run("DELETE FROM sessions WHERE expires<?", Date.now());
  run(
    "INSERT INTO sessions VALUES(?,?,?)",
    hash(id),
    JSON.stringify(data),
    Date.now() + 8 * 3600000,
  );
  res.cookie("journal", id, {
    httpOnly: true,
    sameSite: "lax",
    secure: !demo,
    maxAge: 8 * 3600000,
    path: "/",
  });
}
const auth = (req, res, next) =>
  req.session?.user
    ? next()
    : res.status(401).json({ error: "Войдите в свой кабинет" });
const admin = (req, res, next) =>
  ["admin", "office"].includes(req.session?.user?.role)
    ? next()
    : res.status(403).json({ error: "Доступ только для учебного офиса" });
app.get("/healthz", (req, res) => {
  get("SELECT 1");
  res.json({ ok: true });
});
app.get("/api/session", (req, res) =>
  res.json({
    user: req.session?.user || null,
    demo: demo && process.env.DATA_MODE !== "live",
    demoStudents: demoStudentLogin ? roster.students : [],
    selection,
    teachers: selection ? roster.teachers : [],
    managers: selection ? managers : [],
  }),
);
app.post("/api/select-login", (req, res) => {
  if (!selection) return res.sendStatus(404);
  const { role, personId } = req.body;
  const person =
    role === "teacher"
      ? roster.teachers.find((t) => t.id === personId)
      : managers.find((m) => m.id === personId && m.role === role);
  if (!person || !["teacher", "office", "admin"].includes(role))
    throw fail(400, "Выберите роль и сотрудника из списка");
  checkManagementPassword(req);
  if (req.sessionKey) run("DELETE FROM sessions WHERE id=?", req.sessionKey);
  const user = { ...person, role, source: "selection" };
  session(res, { user, managementVersion });
  res.json({ user });
});
app.post("/api/demo-login", (req, res) => {
  if (!demo) return res.sendStatus(404);
  const role = req.body.role;
  checkManagementPassword(req);
  if (role === "student") {
    if (!demoStudentLogin) throw fail(403, "Демо-вход студентом отключён");
    const student = roster.students.find((s) => s.id === req.body.studentId);
    if (!student) throw fail(400, "Выберите студента");
    if (!cabinetOpen(student.id))
      throw fail(403, "Личный кабинет закрыт: обучение завершено");
    if (req.sessionKey) run("DELETE FROM sessions WHERE id=?", req.sessionKey);
    const user = {
      id: student.id,
      name: student.name,
      role: "student",
      studentId: student.id,
      source: "demo",
    };
    session(res, { user, managementVersion });
    return res.json({ user });
  }
  const teacher = roster.teachers.find((t) => t.id === req.body.teacherId);
  if (role !== "admin" && !teacher) throw fail(400, "Выберите преподавателя");
  if (req.sessionKey) run("DELETE FROM sessions WHERE id=?", req.sessionKey);
  const user =
    role === "admin"
      ? { id: "demo_admin", name: "Полный доступ", role: "admin" }
      : { ...teacher, role: "teacher" };
  session(res, { user, managementVersion });
  res.json({ user });
});
app.post("/api/logout", (req, res) => {
  if (req.sessionKey) run("DELETE FROM sessions WHERE id=?", req.sessionKey);
  res.clearCookie("journal", { path: "/" });
  res.json({ ok: true });
});
let oidcConfig;
async function config() {
  if (!process.env.OIDC_ISSUER || !process.env.OIDC_CLIENT_ID)
    throw fail(
      503,
      "Вход ВШЭ ещё не подключён. Учебному офису необходимо зарегистрировать приложение у провайдера авторизации.",
    );
  return (oidcConfig ??= await oidc.discovery(
    new URL(process.env.OIDC_ISSUER),
    process.env.OIDC_CLIENT_ID,
    process.env.OIDC_CLIENT_SECRET,
  ));
}
app.get("/auth/login", async (req, res) => {
  if (selection) return res.redirect("/");
  const c = await config(),
    verifier = oidc.randomPKCECodeVerifier(),
    state = oidc.randomState(),
    nonce = oidc.randomNonce();
  session(res, { verifier, state, nonce, created: Date.now() });
  res.redirect(
    oidc.buildAuthorizationUrl(c, {
      redirect_uri: origin + "/auth/callback",
      scope: "openid email profile",
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
      code_challenge_method: "S256",
      state,
      nonce,
    }).href,
  );
});
app.get("/auth/callback", async (req, res) => {
  const s = req.session;
  if (!s?.verifier || Date.now() - s.created > 600000)
    throw fail(401, "Время входа истекло. Повторите вход.");
  run("DELETE FROM sessions WHERE id=?", req.sessionKey);
  const t = await oidc.authorizationCodeGrant(
    await config(),
    new URL(req.originalUrl, origin),
    {
      pkceCodeVerifier: s.verifier,
      expectedState: s.state,
      expectedNonce: s.nonce,
      idTokenExpected: true,
    },
  );
  const claims = t.claims();
  const email = String(claims.email || "").toLowerCase();
  const account = accounts.find(
    (a) => a.email.toLowerCase() === email && a.subject === claims.sub,
  );
  if (!account) {
    // Студенты входят по @edu.hse.ru – проверка домена почты им не требуется.
    const studentId = studentByExternalId(claims.sub);
    const student =
      studentId && roster.students.find((s) => s.id === studentId);
    // Студент попадает на экран входа с объяснением, а не на голый JSON.
    if (!student) return res.redirect("/?error=unlinked");
    if (!cabinetOpen(studentId)) return res.redirect("/?error=closed");
    session(res, {
      user: {
        id: studentId,
        name: student.name,
        role: "student",
        studentId,
        source: "oidc",
        subject: claims.sub,
      },
    });
    return res.redirect("/");
  }
  if (
    claims.email_verified !== true ||
    !email.endsWith("@hse.ru") ||
    !["admin", "teacher"].includes(account.role)
  )
    throw fail(
      403,
      "Учётная запись не подключена к журналу. Обратитесь в учебный офис.",
    );
  if (
    account.role === "teacher" &&
    !roster.teachers.some((t) => t.id === account.teacherId)
  )
    throw fail(403, "Преподаватель не сопоставлен с базой");
  session(res, {
    user: {
      id: account.teacherId || account.subject,
      name: account.name,
      email,
      role: account.role,
      source: "explicit",
      subject: claims.sub,
    },
  });
  res.redirect("/");
});
app.use("/api", auth);
registerDaily(app, { db, roster, auth, admin, studentProfile, audit });
registerStudent(app, { db, studentProfile, audit, proceduresFor, uploadDir });
app.use("/api/admin", admin);
function studentProfile(id) {
  const base = roster.students.find((s) => s.id === id);
  if (!base) throw fail(404, "Студент не найден");
  return {
    ...base,
    ...JSON.parse(
      get("SELECT data FROM student_profiles WHERE studentId=?", id)?.data ||
        "{}",
    ),
  };
}
// Привязка живёт отдельной таблицей: обновление реестра из Excel пересобирает
// записи студентов, а связь с учётной записью обязана это пережить.
function studentByExternalId(externalId) {
  return (
    get("SELECT studentId FROM student_accounts WHERE externalId=?", externalId)
      ?.studentId || null
  );
}
// Кабинет открыт студенту из реестра, пока он не выпустился и не отчислен.
// Академический отпуск доступ не закрывает (решение владельца 23.09.2026).
function cabinetOpen(studentId) {
  if (!roster.students.some((s) => s.id === studentId)) return false;
  const status = JSON.parse(
    get("SELECT data FROM student_profiles WHERE studentId=?", studentId)
      ?.data || "{}",
  ).enrollmentStatus;
  return !closedEnrollmentStatuses.includes(status);
}
function proceduresFor(id) {
  const rows = all("SELECT kind,data FROM procedures WHERE studentId=?", id),
    today = moscowDate();
  return procedureCatalog.map((c) => {
    const row = rows.find((r) => r.kind === c.id);
    const record = row
      ? JSON.parse(row.data)
      : {
          state: "unknown",
          dueDate: "",
          validUntil: "",
          completedAt: "",
          note: "",
        };
    return { ...c, ...record, status: procedureStatus(record, today) };
  });
}
function editable(req, id) {
  const student = studentProfile(id);
  if (!canEditStudent(req.session.user, student))
    throw fail(
      403,
      "Изменять данные может менеджер программы и курса или руководство учебного офиса",
    );
  return student;
}
app.get("/api/admin/directory", (req, res) =>
  res.json({ managers, programs, source: directorySource }),
);
// Обновление реестра из нового Excel: без ?apply=1 – только план, с ним – запись в одной транзакции.
app.post(
  "/api/admin/import",
  express.raw({ type: () => true, limit: "25mb" }),
  (req, res) => {
    registryAdmin(req);
    if (!Buffer.isBuffer(req.body) || !req.body.length)
      throw fail(400, "Загрузите файл .xlsx");
    const plan = planImport(roster, parseRoster(req.body));
    const teacherName = (id) =>
      (
        roster.teachers.find((t) => t.id === id) ||
        plan.teachers.add.find((t) => t.id === id)
      )?.name;
    const studentName = (id) =>
      (
        roster.students.find((x) => x.id === id) ||
        plan.students.add.find((x) => x.id === id)
      )?.name;
    const describe = (e) =>
      `${studentName(e.studentId)} – ${teacherName(e.teacherId)} – ${e.course}${e.group ? " (" + e.group + ")" : ""}`;
    const summary = {
      students: {
        added: plan.students.add.map((x) => x.name),
        missing: plan.students.missing,
      },
      teachers: { added: plan.teachers.add.map((t) => t.name) },
      enrollments: {
        added: plan.enrollments.add.length,
        removed: plan.enrollments.remove.length,
        addedList: plan.enrollments.add.map(describe),
        removedList: plan.enrollments.remove.map(describe),
      },
      quality: plan.quality,
      studentsInFile: plan.studentsInFile,
    };
    if (req.query.apply !== "1") return res.json({ preview: true, ...summary });
    db.exec("BEGIN IMMEDIATE");
    try {
      applyImport({ run, roster, addEnrollment }, plan);
      audit(
        req.session.user,
        "roster.import",
        "roster",
        `студентов +${summary.students.added.length}, преподавателей +${summary.teachers.added.length}, связей +${summary.enrollments.added} −${summary.enrollments.removed}`,
      );
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    res.json({ preview: false, ...summary });
  },
);
app.get("/api/admin/teachers", (req, res) => {
  // Дата последней отметки у каждого преподавателя: по ней видно, кто не ведёт журнал.
  const lastMarks = new Map(
    all(
      "SELECT teacherId, max(date) AS last FROM daily_marks GROUP BY teacherId",
    ).map((r) => [r.teacherId, r.last]),
  );
  res.json(
    roster.teachers
      .map((t) => ({
        ...t,
        lastMark: lastMarks.get(t.id) || null,
        courses: [
          ...new Set(enrollmentsOf("teacherId", t.id).map((e) => e.course)),
        ].sort(ruCompare),
        students: new Set(
          enrollmentsOf("teacherId", t.id).map((e) => e.studentId),
        ).size,
      }))
      .sort((a, b) => ruCompare(a.name, b.name)),
  );
});
// Преподаватели со студентами, у которых нет ни одной отметки за последние 7 дней.
function silentTeachers() {
  const since = new Date(moscowDate() + "T12:00:00Z");
  since.setUTCDate(since.getUTCDate() - 7);
  const active = new Set(
    all(
      "SELECT DISTINCT teacherId FROM daily_marks WHERE date>=?",
      since.toISOString().slice(0, 10),
    ).map((r) => r.teacherId),
  );
  const withStudents = new Set(roster.enrollments.map((e) => e.teacherId));
  return roster.teachers.filter(
    (t) => withStudents.has(t.id) && !active.has(t.id),
  ).length;
}
// Новый учебный год: все обучающиеся студенты с курсом переходят на следующий; выпуск и отчисление – в карточке.
app.post("/api/admin/year-rollover", (req, res) => {
  registryAdmin(req);
  let count = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of all("SELECT studentId, data FROM student_profiles")) {
      const p = JSON.parse(row.data);
      if (
        !(p.year >= 1 && p.year < 6) ||
        (p.enrollmentStatus && p.enrollmentStatus !== "active")
      )
        continue;
      p.year += 1;
      p.version = (p.version || 0) + 1;
      run(
        "UPDATE student_profiles SET data=? WHERE studentId=?",
        JSON.stringify(p),
        row.studentId,
      );
      count++;
    }
    const state = {
      at: new Date().toISOString(),
      count,
      actor: req.session.user.name,
    };
    run(
      "INSERT OR REPLACE INTO service_state VALUES('yearRollover',?)",
      JSON.stringify(state),
    );
    audit(
      req.session.user,
      "year.rollover",
      "roster",
      `${count} студентов переведены на следующий курс`,
    );
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  res.json({ count });
});
app.post("/api/admin/students", (req, res) => {
  registryStaff(req);
  const {
    name,
    program = "",
    year = 0,
    foreignStatus = "confirmed",
    citizenship = "",
    links,
  } = req.body;
  const clean = registryName(name, roster.students);
  if (
    (program !== "" && !programs.includes(program)) ||
    !Number.isInteger(year) ||
    year < 0 ||
    year > 6 ||
    !["unknown", "confirmed", "excluded"].includes(foreignStatus) ||
    !studentFieldsValid({ citizenship })
  )
    throw fail(400, "Проверьте ФИО, программу, курс и гражданство");
  if (
    req.session.user.role === "office" &&
    managerFor({ program, year })?.id !== req.session.user.id
  )
    throw fail(
      403,
      "Менеджер добавляет студентов только своих программ и курсов",
    );
  if (
    !Array.isArray(links) ||
    !links.length ||
    links.length > 50 ||
    links.some(
      (l) =>
        !l ||
        !roster.teachers.some((t) => t.id === l.teacherId) ||
        typeof l.course !== "string" ||
        !l.course.trim() ||
        l.course.length > 200 ||
        (l.group != null &&
          (typeof l.group !== "string" || l.group.length > 100)),
    )
  )
    throw fail(400, "Укажите хотя бы одного преподавателя и дисциплину");
  const id = studentId(clean);
  if (roster.students.some((s) => s.id === id))
    throw fail(409, "Студент с таким ФИО уже есть в реестре");
  const enrollments = links.map((l) => ({
    studentId: id,
    teacherId: l.teacherId,
    group: (l.group || "").trim(),
    course: l.course.trim(),
    kind: "ручной ввод",
  }));
  const profile = {
    version: 1,
    program,
    year,
    foreignStatus,
    citizenship: citizenship.trim(),
    arrivalDate: "",
    residence: "",
    enrollmentStatus: "active",
  };
  db.exec("BEGIN IMMEDIATE");
  try {
    run("INSERT INTO roster_students VALUES(?,?)", id, clean);
    enrollments.forEach(addEnrollment);
    run(
      "INSERT OR REPLACE INTO student_profiles VALUES(?,?)",
      id,
      JSON.stringify(profile),
    );
    audit(req.session.user, "student.add", id, clean);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  roster.students.push({ id, name: clean });
  roster.enrollments.push(...enrollments);
  res.json({ id, version: 1, manager: managerFor(profile) });
});
// Правка реестра через сайт: преподаватели, ФИО студентов, связи «студент – преподаватель – дисциплина».
function registryAdmin(req) {
  if (req.session.user.role !== "admin")
    throw fail(403, "Это изменение доступно только полному доступу");
}
// Менеджер и полный доступ добавляют студентов и преподавателей.
function registryStaff(req) {
  if (!["admin", "office"].includes(req.session.user.role))
    throw fail(403, "Реестр меняют менеджеры и полный доступ");
}
// Менеджер меняет ФИО, связи и удаляет только студентов своих программ и курсов.
function registryStudent(req, id) {
  const student = registryEntry(roster.students, id, "Студент не найден");
  if (!canEditStudent(req.session.user, studentProfile(id)))
    throw fail(403, "Менеджер меняет только студентов своих программ и курсов");
  return student;
}
function registryName(name, list, exceptId) {
  const clean =
    typeof name === "string" ? name.trim().replace(/\s+/g, " ") : "";
  if (clean.length < 3 || clean.length > 150)
    throw fail(400, "Укажите ФИО от 3 до 150 символов");
  const lower = clean.toLocaleLowerCase("ru");
  if (
    list.some(
      (x) => x.id !== exceptId && x.name.toLocaleLowerCase("ru") === lower,
    )
  )
    throw fail(409, "Такое ФИО уже есть в реестре");
  return clean;
}
function registryEntry(list, id, message) {
  const entry = list.find((x) => x.id === id);
  if (!entry) throw fail(404, message);
  return entry;
}
app.post("/api/admin/teachers", (req, res) => {
  registryStaff(req);
  const name = registryName(req.body.name, roster.teachers),
    id = "t_" + randomBytes(8).toString("hex");
  run("INSERT INTO roster_teachers VALUES(?,?)", id, name);
  audit(req.session.user, "teacher.add", id, name);
  roster.teachers.push({ id, name });
  res.json({ id, name });
});
app.put("/api/admin/teachers/:id", (req, res) => {
  registryAdmin(req);
  const teacher = registryEntry(
    roster.teachers,
    req.params.id,
    "Преподаватель не найден",
  );
  const name = registryName(req.body.name, roster.teachers, teacher.id);
  run("UPDATE roster_teachers SET name=? WHERE id=?", name, teacher.id);
  audit(
    req.session.user,
    "teacher.rename",
    teacher.id,
    teacher.name + " → " + name,
  );
  teacher.name = name;
  res.json({ ok: true, name });
});
app.delete("/api/admin/teachers/:id", (req, res) => {
  registryAdmin(req);
  const { id, name } = registryEntry(
    roster.teachers,
    req.params.id,
    "Преподаватель не найден",
  );
  if (
    roster.enrollments.some((e) => e.teacherId === id) ||
    get("SELECT 1 FROM daily_marks WHERE teacherId=?", id) ||
    get(
      "SELECT 1 FROM marks m JOIN lessons l ON l.id=m.lessonId WHERE l.teacherId=?",
      id,
    )
  )
    throw fail(
      409,
      "У преподавателя есть студенты или отметки. Удалить можно только запись без связей и истории",
    );
  run("DELETE FROM roster_teachers WHERE id=?", id);
  audit(req.session.user, "teacher.delete", id, name);
  roster.teachers = roster.teachers.filter((t) => t.id !== id);
  res.json({ ok: true });
});
app.put("/api/admin/students/:id", (req, res) => {
  const student = registryStudent(req, req.params.id);
  const name = registryName(req.body.name, roster.students, student.id);
  run("UPDATE roster_students SET name=? WHERE id=?", name, student.id);
  audit(
    req.session.user,
    "student.rename",
    student.id,
    student.name + " → " + name,
  );
  student.name = name;
  res.json({ ok: true, name });
});
app.delete("/api/admin/students/:id", (req, res) => {
  const { id, name } = registryStudent(req, req.params.id);
  if (
    get("SELECT 1 FROM daily_marks WHERE studentId=?", id) ||
    get("SELECT 1 FROM marks WHERE studentId=?", id)
  )
    throw fail(
      409,
      "У студента есть отметки. Вместо удаления смените статус обучения в карточке",
    );
  // ID производится от ФИО: удалённая вместе с записью привязка или сканы
  // достались бы новому студенту с тем же ФИО. Сканы удаляются только вручную.
  const linked = get("SELECT 1 FROM student_accounts WHERE studentId=?", id),
    scans = get("SELECT 1 FROM attachments WHERE studentId=?", id);
  if (linked || scans)
    throw fail(
      409,
      "Сначала " +
        [
          linked && "отвяжите учётную запись ВШЭ",
          scans && "удалите приложенные сканы",
        ]
          .filter(Boolean)
          .join(" и "),
    );
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const table of [
      "roster_enrollments",
      "student_profiles",
      "procedures",
      "debts",
    ])
      run(`DELETE FROM ${table} WHERE studentId=?`, id);
    run("DELETE FROM roster_students WHERE id=?", id);
    audit(req.session.user, "student.delete", id, name);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  roster.students = roster.students.filter((s) => s.id !== id);
  roster.enrollments = roster.enrollments.filter((e) => e.studentId !== id);
  res.json({ ok: true });
});
// Связь = студент + преподаватель + дисциплина + группа (группа необязательна).
function enrollmentKey(body) {
  const { studentId, teacherId, course, group = "" } = body;
  if (
    !roster.students.some((s) => s.id === studentId) ||
    !roster.teachers.some((t) => t.id === teacherId) ||
    typeof course !== "string" ||
    !course.trim() ||
    course.length > 200 ||
    typeof group !== "string" ||
    group.length > 100
  )
    throw fail(400, "Укажите студента, преподавателя, дисциплину и группу");
  return { studentId, teacherId, course: course.trim(), group: group.trim() };
}
const enrollmentEntity = (key) =>
  [key.studentId, key.teacherId, key.course, key.group]
    .filter(Boolean)
    .join(":");
const sameEnrollment = (e, key) =>
  e.studentId === key.studentId &&
  e.teacherId === key.teacherId &&
  e.course === key.course &&
  e.group === key.group;
// Записи до появления колонки label: имена подставляются по ID, если запись ещё в реестре.
const auditLabel = (entity) =>
  String(entity)
    .split(":")
    .map(
      (part) =>
        roster.students.find((s) => s.id === part)?.name ||
        roster.teachers.find((t) => t.id === part)?.name ||
        part,
    )
    .join(" – ");
const enrollmentLabel = (key) =>
  roster.students.find((s) => s.id === key.studentId)?.name +
  " – " +
  roster.teachers.find((t) => t.id === key.teacherId)?.name +
  " – " +
  key.course +
  (key.group ? " (" + key.group + ")" : "");
app.post("/api/admin/enrollments", (req, res) => {
  const key = enrollmentKey(req.body);
  registryStudent(req, key.studentId);
  if (roster.enrollments.some((e) => sameEnrollment(e, key)))
    throw fail(409, "Такая связь уже есть в реестре");
  const enrollment = { ...key, kind: "ручной ввод" };
  addEnrollment(enrollment);
  audit(
    req.session.user,
    "enrollment.add",
    enrollmentEntity(key),
    enrollmentLabel(key),
  );
  roster.enrollments.push(enrollment);
  res.json({ ok: true });
});
app.delete("/api/admin/enrollments", (req, res) => {
  const key = enrollmentKey(req.body);
  registryStudent(req, key.studentId);
  const { changes } = run(
    "DELETE FROM roster_enrollments WHERE studentId=? AND teacherId=? AND course=? AND grp=?",
    key.studentId,
    key.teacherId,
    key.course,
    key.group,
  );
  if (!changes) throw fail(404, "Связь не найдена");
  audit(
    req.session.user,
    "enrollment.delete",
    enrollmentEntity(key),
    enrollmentLabel(key),
  );
  roster.enrollments = roster.enrollments.filter(
    (e) => !sameEnrollment(e, key),
  );
  res.json({ ok: true });
});
app.put("/api/admin/students/:id/profile", (req, res) => {
  if (req.session.user.role !== "admin")
    throw fail(
      403,
      "Распределение студентов меняет руководство учебного офиса",
    );
  const previous = studentProfile(req.params.id);
  const {
    program,
    year,
    foreignStatus,
    citizenship = "",
    arrivalDate = "",
    residence = "",
    enrollmentStatus = "active",
    nameLatin = "",
    sendingCountry = "",
    programVersion = "",
    curator = "",
    housing = "",
    inRussia = "",
    passportUntil = "",
    migrationCardUntil = "",
  } = req.body;
  if (
    !studentFieldsValid({
      citizenship,
      arrivalDate,
      residence,
      nameLatin,
      sendingCountry,
      programVersion,
      curator,
      housing,
      inRussia,
      passportUntil,
      migrationCardUntil,
    })
  )
    throw fail(400, studentFieldsError);
  if (
    (program !== "" && !programs.includes(program)) ||
    !Number.isInteger(year) ||
    year < 0 ||
    year > 6 ||
    !["unknown", "confirmed", "excluded"].includes(foreignStatus) ||
    !enrollmentStatuses.includes(enrollmentStatus)
  )
    throw fail(400, "Проверьте программу, курс и данные студента");
  if (req.body.version !== (previous.version || 0))
    throw fail(
      409,
      "Карточка изменена другим сотрудником. Сохраните свои правки и откройте карточку заново",
    );
  const data = {
    version: (previous.version || 0) + 1,
    program,
    year,
    foreignStatus,
    citizenship: citizenship.trim(),
    arrivalDate,
    residence,
    enrollmentStatus,
    nameLatin: nameLatin.trim(),
    sendingCountry: sendingCountry.trim(),
    programVersion: programVersion.trim(),
    curator: curator.trim(),
    housing,
    inRussia,
    passportUntil,
    migrationCardUntil,
  };
  run(
    "INSERT OR REPLACE INTO student_profiles VALUES(?,?)",
    req.params.id,
    JSON.stringify(data),
  );
  audit(req.session.user, "student.profile", req.params.id);
  res.json({ ok: true, version: data.version, manager: managerFor(data) });
});
app.put("/api/admin/students/:id/account", (req, res) => {
  editable(req, req.params.id);
  const externalId =
    typeof req.body.externalId === "string" ? req.body.externalId.trim() : "";
  if (!externalId || externalId.length > 200)
    throw fail(400, "Укажите идентификатор учётной записи");
  const taken = studentByExternalId(externalId);
  if (taken && taken !== req.params.id)
    throw fail(409, "Эта учётная запись уже связана с другим студентом");
  run("DELETE FROM student_accounts WHERE studentId=?", req.params.id);
  run(
    "INSERT INTO student_accounts VALUES(?,?,?,?)",
    externalId,
    req.params.id,
    new Date().toISOString(),
    req.session.user.name,
  );
  audit(req.session.user, "account.link", req.params.id, externalId);
  res.json({ ok: true });
});
app.delete("/api/admin/students/:id/account", (req, res) => {
  editable(req, req.params.id);
  run("DELETE FROM student_accounts WHERE studentId=?", req.params.id);
  audit(req.session.user, "account.unlink", req.params.id);
  res.json({ ok: true });
});
// Сотрудник снимает скан независимо от состояния требования – в отличие от
// студенческого маршрута в src/student.js, который блокирует это после подтверждения.
app.delete("/api/admin/attachments/:id", (req, res) => {
  const row = get("SELECT * FROM attachments WHERE id=?", req.params.id);
  if (!row) throw fail(404, "Файл не найден");
  editable(req, row.studentId);
  rmSync(attachmentPath(uploadDir, row.studentId, row.storedName), {
    force: true,
  });
  run("DELETE FROM attachments WHERE id=?", req.params.id);
  audit(
    req.session.user,
    "attachment.delete",
    row.studentId + ":" + row.id,
    attachmentLabel(studentProfile(row.studentId).name, row),
  );
  res.json({ ok: true });
});
app.get("/api/admin/students-without-account", (req, res) => {
  registryStaff(req);
  const linked = new Set(
    all("SELECT studentId FROM student_accounts").map((r) => r.studentId),
  );
  const students = roster.students
    .map((s) => studentProfile(s.id))
    .filter((s) => !linked.has(s.id))
    .filter((s) => canSeeStudent(req.session.user, s))
    .map((s) => ({
      id: s.id,
      name: s.name,
      program: s.program || "",
      year: s.year || 0,
      manager: managerFor(s),
    }));
  res.json({ students });
});
app.put("/api/admin/students/:id/procedures/:kind", (req, res) => {
  editable(req, req.params.id);
  if (!procedureCatalog.some((c) => c.id === req.params.kind))
    throw fail(404, "Требование не найдено");
  const {
    state,
    dueDate = "",
    validUntil = "",
    completedAt = "",
    note = "",
  } = req.body;
  if (
    !procedureStates.includes(state) ||
    ![dueDate, validUntil, completedAt].every(validDate) ||
    typeof note !== "string" ||
    note.length > 1000 ||
    (state === "confirmed" && (!completedAt || completedAt > moscowDate())) ||
    (state === "exempt" && !note.trim()) ||
    (completedAt && validUntil && validUntil < completedAt)
  )
    throw fail(
      400,
      "Проверьте даты. Для подтверждения нужна дата выполнения, для освобождения – основание",
    );
  const previous = proceduresFor(req.params.id).find(
    (p) => p.id === req.params.kind,
  );
  if (req.body.version !== (previous.version || 0))
    throw fail(
      409,
      "Требование изменено другим сотрудником. Сохраните свои правки и откройте карточку заново",
    );
  const data = {
    version: (previous.version || 0) + 1,
    state,
    dueDate,
    validUntil,
    completedAt,
    note: note.trim(),
    checkedBy: req.session.user.name,
    submittedBy: "staff",
    submittedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  run(
    "INSERT OR REPLACE INTO procedures VALUES(?,?,?)",
    req.params.id,
    req.params.kind,
    JSON.stringify(data),
  );
  audit(
    req.session.user,
    "procedure.update",
    req.params.id + ":" + req.params.kind,
  );
  res.json({ ok: true, version: data.version });
});
// Отметки, задолженности и связи раскладываются по ключу за один проход; порядок внутри ключа прежний.
const groupBy = (rows, field, only) => {
  const map = new Map();
  for (const r of rows)
    if (only === undefined || r[field] === only)
      (map.get(r[field]) || map.set(r[field], []).get(r[field])).push(r);
  return map;
};
// Реестр меняет связи только заменой массива roster.enrollments или дописыванием
// в его конец – по этим признакам словари связей пересобираются.
let enrollmentIndex = null;
function enrollmentsOf(field, id) {
  const list = roster.enrollments;
  if (enrollmentIndex?.list !== list || enrollmentIndex.length !== list.length)
    enrollmentIndex = {
      list,
      length: list.length,
      studentId: groupBy(list, "studentId"),
      teacherId: groupBy(list, "teacherId"),
    };
  return enrollmentIndex[field].get(id) || [];
}
// Без аргумента – все студенты реестра, с id – только этот (для карточки).
function studentRows(only) {
  const records = groupBy(attendanceRecords(db, only), "studentId"),
    debts = groupBy(all("SELECT * FROM debts"), "studentId", only),
    teacherNames = new Map(roster.teachers.map((t) => [t.id, t.name]));
  const students =
    only === undefined
      ? roster.students
      : roster.students.filter((s) => s.id === only);
  return students.map((s) => {
    const profile = studentProfile(s.id),
      procedures = proceduresFor(s.id),
      own = records.get(s.id) || [];
    return {
      ...profile,
      manager: managerFor(profile),
      procedureOverdue: procedures.filter((p) =>
        ["overdue", "expired"].includes(p.status),
      ).length,
      procedureUnknown: procedures.filter((p) => p.status === "unknown").length,
      procedureReview: procedures.filter((p) => p.status === "submitted")
        .length,
      groups: [
        ...new Set(enrollmentsOf("studentId", s.id).map((e) => e.group)),
      ],
      teacherIds: [
        ...new Set(enrollmentsOf("studentId", s.id).map((e) => e.teacherId)),
      ],
      ...studentMetrics(own, debts.get(s.id) || []),
      // Где и на каких занятиях был студент: новые отметки сверху.
      records: own
        .sort((a, b) => b.date.localeCompare(a.date))
        .map((r) => ({
          date: r.date,
          course: r.course,
          teacher: teacherNames.get(r.teacherId),
          status: r.status,
        })),
    };
  });
}
app.get("/api/admin/overview", (req, res) => {
  const students = studentRows().filter((s) =>
    canSeeStudent(req.session.user, s),
  );
  res.json({
    students: students.map((s) => ({
      ...s,
      canEdit: canEditStudent(req.session.user, s),
    })),
    faculty: {
      loaded: students.length,
      confirmed: students.filter(
        (s) =>
          s.foreignStatus === "confirmed" &&
          (!s.enrollmentStatus || s.enrollmentStatus === "active"),
      ).length,
      unverified: students.filter(
        (s) => !s.foreignStatus || s.foreignStatus === "unknown",
      ).length,
      unassigned: students.filter((s) => !s.manager).length,
      silentTeachers: silentTeachers(),
    },
    yearRollover: JSON.parse(
      get("SELECT value FROM service_state WHERE key='yearRollover'")?.value ||
        "null",
    ),
    quality: roster.quality,
    teachers: roster.teachers.length,
    backup: get("SELECT value FROM service_state WHERE key='backup'"),
    audit:
      req.session.user.role === "admin"
        ? all(
            `SELECT actor,role,action,entity,label,at FROM audit WHERE action IN (${registryActions.map(() => "?").join(",")}) ORDER BY id DESC LIMIT 30`,
            ...registryActions,
          ).map((a) => ({ ...a, label: a.label || auditLabel(a.entity) }))
        : [],
  });
});
app.get("/api/admin/students/:id", (req, res) => {
  const [student] = studentRows(req.params.id);
  if (!student) throw fail(404, "Студент не найден");
  if (!canSeeStudent(req.session.user, student))
    throw fail(403, "Студент не относится к вашим программам и курсам");
  const account = get(
    "SELECT externalId,linkedAt,linkedBy FROM student_accounts WHERE studentId=?",
    student.id,
  );
  res.json({
    student,
    canEdit: canEditStudent(req.session.user, student),
    programs,
    procedures: proceduresFor(student.id),
    records: student.records,
    account: account || null,
    attachments: all(
      "SELECT id,kind,fileName,size,uploadedAt,uploadedBy FROM attachments WHERE studentId=? ORDER BY uploadedAt",
      student.id,
    ),
    debts: all(
      "SELECT * FROM debts WHERE studentId=? ORDER BY createdAt DESC",
      student.id,
    ),
    courses: [
      ...new Set(enrollmentsOf("studentId", student.id).map((e) => e.course)),
    ],
    links: [
      ...new Map(
        enrollmentsOf("studentId", student.id).map((e) => [
          e.teacherId + "\n" + e.course + "\n" + e.group,
          {
            teacherId: e.teacherId,
            teacher: roster.teachers.find((t) => t.id === e.teacherId)?.name,
            course: e.course,
            group: e.group,
          },
        ]),
      ).values(),
    ],
  });
});
app.get("/api/admin/export", (req, res) => {
  const esc = csvCell;
  const rows = studentRows()
    .filter((s) => canSeeStudent(req.session.user, s))
    .map((s) => [
      s.name,
      s.attendance ?? "",
      s.absences,
      s.lastVisit || "",
      s.debtCount,
      s.days,
      s.absenceAlert ? "Да" : "Нет",
      s.attention ? "Да" : "Нет",
      s.program || "",
      s.year || "",
      s.foreignStatus || "unknown",
      s.enrollmentStatus || "active",
      s.manager?.name || "",
      s.procedureOverdue,
      s.procedureReview,
      s.procedureUnknown,
    ]);
  res.set({
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": 'attachment; filename="attendance.csv"',
  });
  res.send(
    "\uFEFF" +
      [
        [
          "Студент",
          "Посещаемость, %",
          "Пропуски",
          "Последнее посещение",
          "Учебные задолженности (архив)",
          "Учебных дней без явки",
          "Больше 7 дней без явки",
          "Больше 7 дней и учебная задолженность (архив)",
          "Программа",
          "Курс",
          "Иностранный статус",
          "Обучение",
          "Менеджер",
          "Не выполнены требования",
          "Требования на проверке",
          "Нет данных о требованиях",
        ],
        ...rows,
      ]
        .map((r) => r.map(esc).join(";"))
        .join("\r\n"),
  );
});
app.use(express.static("public"));
app.use((err, req, res, next) => {
  res.status(err.status || 500).json({
    error: err.status
      ? err.message
      : "Не удалось выполнить запрос. Попробуйте ещё раз.",
  });
});
const host = process.env.HOST || "127.0.0.1";
if (demo && host !== "127.0.0.1")
  throw Error("Демонстрационный вход разрешён только на loopback");
const server = app.listen(port, host, () =>
  console.log(
    `Журнал: ${origin} | ${demo ? "Локальный демонстрационный режим" : "Рабочий режим"}`,
  ),
);
let backupTimer,
  backupRunning = false;
async function createBackup() {
  if (backupRunning) return;
  backupRunning = true;
  try {
    const dir = process.env.BACKUP_DIR || "data/backups";
    mkdirSync(dir, { recursive: true });
    const target = path.join(
      dir,
      "attendance-" + new Date().toISOString().replaceAll(":", "-") + ".sqlite",
    );
    await backup(db, target);
    // Имя копии начинается с даты по ISO, поэтому обычная сортировка идёт от старых к новым.
    const kept = Number(process.env.BACKUP_KEEP || 14);
    const copies = readdirSync(dir)
      .filter((name) => /^attendance-.+\.sqlite$/.test(name))
      .sort();
    for (const name of copies.slice(0, -kept))
      rmSync(path.join(dir, name), { force: true });
    run(
      "INSERT OR REPLACE INTO service_state VALUES('backup',?)",
      JSON.stringify({ at: new Date().toISOString(), ok: true }),
    );
  } catch {
    run(
      "INSERT OR REPLACE INTO service_state VALUES('backup',?)",
      JSON.stringify({ at: new Date().toISOString(), ok: false }),
    );
  } finally {
    backupRunning = false;
  }
}
if (process.env.AUTO_BACKUP === "true") {
  backupTimer = setInterval(createBackup, 86400000);
  backupTimer.unref();
  createBackup();
}
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(backupTimer);
  server.close(async () => {
    while (backupRunning) await new Promise((r) => setTimeout(r, 50));
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 30000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
