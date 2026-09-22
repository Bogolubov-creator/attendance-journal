import { csvCell } from "./csv.js";
import { registerDaily, attendanceRecords } from "./daily.js";
import { verifyPassword } from "./management-auth.js";
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
} from "./office.js";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { randomBytes, createHash } from "node:crypto";
import * as oidc from "openid-client";
import { backup } from "node:sqlite";
import path from "node:path";
import { moscowDate, studentMetrics } from "./domain.js";
const app = express(),
  port = Number(process.env.PORT || 3100),
  demo = process.env.DEMO_MODE === "true";
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
CREATE TABLE IF NOT EXISTS procedures(studentId TEXT, kind TEXT, data TEXT NOT NULL, PRIMARY KEY(studentId,kind));
CREATE TABLE IF NOT EXISTS roster_additions(id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS roster_students(id TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS roster_teachers(id TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS roster_enrollments(studentId TEXT NOT NULL, teacherId TEXT NOT NULL, grp TEXT NOT NULL, course TEXT NOT NULL, kind TEXT NOT NULL);`);
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
const audit = (u, action, entity) =>
  run(
    "INSERT INTO audit(actor,action,entity,at) VALUES(?,?,?,?)",
    u.email || u.name,
    action,
    entity,
    new Date().toISOString(),
  );
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
function checkManagementPassword(req) {
  if (!managementHash) throw fail(503, "Пароль ещё не настроен");
  const now = Date.now();
  for (const [key, value] of loginAttempts)
    if (value.until <= now) loginAttempts.delete(key);
  const key = req.ip;
  const attempt = loginAttempts.get(key) || {
    count: 0,
    until: now + 15 * 60000,
  };
  if (attempt.count >= 5)
    throw fail(429, "Слишком много попыток. Повторите через 15 минут.");
  if (!verifyPassword(req.body.password, managementHash)) {
    attempt.count++;
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
  if (
    ["admin", "office"].includes(req.session?.user?.role) &&
    (selection || demo) &&
    (!managementHash || req.session.managementVersion !== managementVersion)
  ) {
    run("DELETE FROM sessions WHERE id=?", req.sessionKey);
    req.session = null;
  }

  if (selection && req.session?.user?.source === "selection") {
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
    oidcReady: !!(process.env.OIDC_ISSUER && process.env.OIDC_CLIENT_ID),
    demoTeachers: demo ? roster.teachers : [],
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
  if (
    claims.email_verified !== true ||
    !email.endsWith("@hse.ru") ||
    !account ||
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
app.get("/api/admin/teachers", (req, res) =>
  res.json(
    roster.teachers
      .map((t) => ({
        ...t,
        courses: [
          ...new Set(
            roster.enrollments
              .filter((e) => e.teacherId === t.id)
              .map((e) => e.course),
          ),
        ].sort((a, b) => a.localeCompare(b, "ru")),
      }))
      .sort((a, b) => a.name.localeCompare(b.name, "ru")),
  ),
);
app.post("/api/admin/students", (req, res) => {
  if (req.session.user.role !== "admin")
    throw fail(403, "Добавляет студентов руководство учебного офиса");
  const {
    name,
    program = "",
    year = 0,
    foreignStatus = "confirmed",
    citizenship = "",
    links,
  } = req.body;
  const clean =
    typeof name === "string" ? name.trim().replace(/\s+/g, " ") : "";
  if (
    clean.length < 3 ||
    clean.length > 150 ||
    (program !== "" && !programs.includes(program)) ||
    !Number.isInteger(year) ||
    year < 0 ||
    year > 6 ||
    !["unknown", "confirmed", "excluded"].includes(foreignStatus) ||
    typeof citizenship !== "string" ||
    citizenship.length > 100
  )
    throw fail(400, "Проверьте ФИО, программу, курс и гражданство");
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
        l.course.length > 200,
    )
  )
    throw fail(400, "Укажите хотя бы одного преподавателя и дисциплину");
  const id = "s_" + hash(clean).slice(0, 16);
  const same = (a, b) =>
    a.toLocaleLowerCase("ru") === b.toLocaleLowerCase("ru");
  if (roster.students.some((s) => s.id === id || same(s.name, clean)))
    throw fail(409, "Студент с таким ФИО уже есть в реестре");
  const enrollments = links.map((l) => ({
    studentId: id,
    teacherId: l.teacherId,
    group: "",
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
    audit(req.session.user, "student.add", id);
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
    throw fail(403, "Реестр меняет руководство учебного офиса");
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
  registryAdmin(req);
  const name = registryName(req.body.name, roster.teachers),
    id = "t_" + randomBytes(8).toString("hex");
  run("INSERT INTO roster_teachers VALUES(?,?)", id, name);
  audit(req.session.user, "teacher.add", id);
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
  audit(req.session.user, "teacher.rename", teacher.id);
  teacher.name = name;
  res.json({ ok: true, name });
});
app.delete("/api/admin/teachers/:id", (req, res) => {
  registryAdmin(req);
  const { id } = registryEntry(
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
  audit(req.session.user, "teacher.delete", id);
  roster.teachers = roster.teachers.filter((t) => t.id !== id);
  res.json({ ok: true });
});
app.put("/api/admin/students/:id", (req, res) => {
  registryAdmin(req);
  const student = registryEntry(
    roster.students,
    req.params.id,
    "Студент не найден",
  );
  const name = registryName(req.body.name, roster.students, student.id);
  run("UPDATE roster_students SET name=? WHERE id=?", name, student.id);
  audit(req.session.user, "student.rename", student.id);
  student.name = name;
  res.json({ ok: true, name });
});
app.delete("/api/admin/students/:id", (req, res) => {
  registryAdmin(req);
  const { id } = registryEntry(
    roster.students,
    req.params.id,
    "Студент не найден",
  );
  if (
    get("SELECT 1 FROM daily_marks WHERE studentId=?", id) ||
    get("SELECT 1 FROM marks WHERE studentId=?", id)
  )
    throw fail(
      409,
      "У студента есть отметки. Вместо удаления смените статус обучения в карточке",
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
    audit(req.session.user, "student.delete", id);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  roster.students = roster.students.filter((s) => s.id !== id);
  roster.enrollments = roster.enrollments.filter((e) => e.studentId !== id);
  res.json({ ok: true });
});
function enrollmentKey(body) {
  const { studentId, teacherId, course } = body;
  if (
    !roster.students.some((s) => s.id === studentId) ||
    !roster.teachers.some((t) => t.id === teacherId) ||
    typeof course !== "string" ||
    !course.trim() ||
    course.length > 200
  )
    throw fail(400, "Укажите студента, преподавателя и дисциплину");
  return { studentId, teacherId, course: course.trim() };
}
app.post("/api/admin/enrollments", (req, res) => {
  registryAdmin(req);
  const key = enrollmentKey(req.body);
  if (
    roster.enrollments.some(
      (e) =>
        e.studentId === key.studentId &&
        e.teacherId === key.teacherId &&
        e.course === key.course,
    )
  )
    throw fail(409, "Такая связь уже есть в реестре");
  const enrollment = { ...key, group: "", kind: "ручной ввод" };
  addEnrollment(enrollment);
  audit(
    req.session.user,
    "enrollment.add",
    key.studentId + ":" + key.teacherId + ":" + key.course,
  );
  roster.enrollments.push(enrollment);
  res.json({ ok: true });
});
app.delete("/api/admin/enrollments", (req, res) => {
  registryAdmin(req);
  const key = enrollmentKey(req.body);
  const { changes } = run(
    "DELETE FROM roster_enrollments WHERE studentId=? AND teacherId=? AND course=?",
    key.studentId,
    key.teacherId,
    key.course,
  );
  if (!changes) throw fail(404, "Связь не найдена");
  audit(
    req.session.user,
    "enrollment.delete",
    key.studentId + ":" + key.teacherId + ":" + key.course,
  );
  roster.enrollments = roster.enrollments.filter(
    (e) =>
      e.studentId !== key.studentId ||
      e.teacherId !== key.teacherId ||
      e.course !== key.course,
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
    [nameLatin, sendingCountry, programVersion, curator].some(
      (v) => typeof v !== "string" || v.length > 200,
    ) ||
    !["", "dormitory", "private"].includes(housing) ||
    !["", "yes", "no"].includes(inRussia) ||
    !validDate(passportUntil) ||
    !validDate(migrationCardUntil)
  )
    throw fail(400, "Проверьте сведения о проживании и сроки документов");
  if (
    (program !== "" && !programs.includes(program)) ||
    !Number.isInteger(year) ||
    year < 0 ||
    year > 6 ||
    !["unknown", "confirmed", "excluded"].includes(foreignStatus) ||
    typeof citizenship !== "string" ||
    citizenship.length > 100 ||
    !validDate(arrivalDate) ||
    ![
      "",
      "visa",
      "visa_free",
      "rvp",
      "rvpo",
      "residence_permit",
      "other",
    ].includes(residence) ||
    !["active", "leave", "graduated", "withdrawn"].includes(enrollmentStatus)
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
app.put("/api/admin/students/:id/procedures/:kind", (req, res) => {
  editable(req, req.params.id);
  if (!procedureCatalog.some((c) => c.id === req.params.kind))
    throw fail(404, "Процедура не найдена");
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
      "Процедура изменена другим сотрудником. Сохраните свои правки и откройте карточку заново",
    );
  const data = {
    version: (previous.version || 0) + 1,
    state,
    dueDate,
    validUntil,
    completedAt,
    note: note.trim(),
    checkedBy: req.session.user.name,
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
function studentRows() {
  const records = attendanceRecords(db),
    debts = all("SELECT * FROM debts"),
    teacherNames = new Map(roster.teachers.map((t) => [t.id, t.name]));
  return roster.students.map((s) => {
    const profile = studentProfile(s.id),
      procedures = proceduresFor(s.id);
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
        ...new Set(
          roster.enrollments
            .filter((e) => e.studentId === s.id)
            .map((e) => e.group),
        ),
      ],
      ...studentMetrics(
        records.filter((r) => r.studentId === s.id),
        debts.filter((d) => d.studentId === s.id),
      ),
      // Где и на каких занятиях был студент: новые отметки сверху.
      records: records
        .filter((r) => r.studentId === s.id)
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
    },
    quality: roster.quality,
    teachers: roster.teachers.length,
    backup: get("SELECT value FROM service_state WHERE key='backup'"),
    audit: all("SELECT * FROM audit ORDER BY id DESC LIMIT 12"),
  });
});
app.get("/api/admin/students/:id", (req, res) => {
  const student = studentRows().find((s) => s.id === req.params.id);
  if (!student) throw fail(404, "Студент не найден");
  if (!canSeeStudent(req.session.user, student))
    throw fail(403, "Студент не относится к вашим программам и курсам");
  res.json({
    student,
    canEdit: canEditStudent(req.session.user, student),
    programs,
    procedures: proceduresFor(student.id),
    records: student.records,
    debts: all(
      "SELECT * FROM debts WHERE studentId=? ORDER BY createdAt DESC",
      student.id,
    ),
    courses: [
      ...new Set(
        roster.enrollments
          .filter((e) => e.studentId === student.id)
          .map((e) => e.course),
      ),
    ],
    links: [
      ...new Map(
        roster.enrollments
          .filter((e) => e.studentId === student.id)
          .map((e) => [
            e.teacherId + "\n" + e.course,
            {
              teacherId: e.teacherId,
              teacher: roster.teachers.find((t) => t.id === e.teacherId)?.name,
              course: e.course,
            },
          ]),
      ).values(),
    ],
  });
});
app.post("/api/admin/debts", (req, res) => {
  const { studentId, title } = req.body;
  if (
    !roster.students.some((s) => s.id === studentId) ||
    typeof title !== "string" ||
    !title.trim() ||
    title.length > 200
  )
    throw fail(400, "Укажите студента и задолженность до 200 символов");
  editable(req, studentId);
  const id = token();
  run(
    "INSERT INTO debts VALUES(?,?,?,0,?)",
    id,
    studentId,
    title.trim(),
    new Date().toISOString(),
  );
  audit(req.session.user, "debt.create", studentId);
  res.json({ id });
});
app.patch("/api/admin/debts/:id", (req, res) => {
  if (typeof req.body.resolved !== "boolean")
    throw fail(400, "Некорректный статус");
  if (!get("SELECT id FROM debts WHERE id=?", req.params.id))
    throw fail(404, "Задолженность не найдена");
  editable(
    req,
    get("SELECT studentId FROM debts WHERE id=?", req.params.id).studentId,
  );
  run(
    "UPDATE debts SET resolved=? WHERE id=?",
    Number(req.body.resolved),
    req.params.id,
  );
  audit(req.session.user, "debt.update", req.params.id);
  res.json({ ok: true });
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
          "Просроченные процедуры",
          "Процедуры на проверке",
          "Нет данных о процедурах",
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
