import { verifyPassword } from "./management-auth.js";
import { parseRuzResponse, loadTeacherSchedule } from "./ruz.js";
import express from "express";
import {
  managers,
  programs,
  directorySource,
  managerFor,
  canEditStudent,
  procedureCatalog,
  procedureStates,
  procedureStatus,
  validDate,
} from "./office.js";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdirSync } from "node:fs";
import { randomBytes, createHash } from "node:crypto";
import * as oidc from "openid-client";
import { createScheduler, resolveTeacherEmail } from "./scheduler.js";
import { backup } from "node:sqlite";
import path from "node:path";
import {
  moscowDate,
  prioritizeLessons,
  studentMetrics,
  statuses,
} from "./domain.js";
const app = express(),
  port = Number(process.env.PORT || 3100),
  demo = process.env.DEMO_MODE === "true";
const selection =
  (process.env.AUTH_MODE || (demo ? "selection" : "oidc")) === "selection";
const origin = process.env.APP_ORIGIN || `http://127.0.0.1:${port}`;
if (!demo && !origin.startsWith("https://"))
  throw Error("В рабочем режиме нужен APP_ORIGIN с HTTPS");
const roster = JSON.parse(readFileSync("data/roster.json", "utf8"));
mkdirSync("data", { recursive: true });
const db = new DatabaseSync(
  process.env.DB_PATH || `data/${demo ? "demo" : "attendance"}.sqlite`,
);
db.exec(
  `PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS lessons(id TEXT PRIMARY KEY,teacherId TEXT,data TEXT);CREATE TABLE IF NOT EXISTS marks(lessonId TEXT,studentId TEXT,status TEXT,note TEXT,updatedAt TEXT, PRIMARY KEY(lessonId,studentId)); CREATE TABLE IF NOT EXISTS revisions(lessonId TEXT PRIMARY KEY,version INTEGER); CREATE TABLE IF NOT EXISTS debts(id TEXT PRIMARY KEY,studentId TEXT,title TEXT,resolved INTEGER DEFAULT 0,createdAt TEXT);CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,actor TEXT,action TEXT,entity TEXT,at TEXT); CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,data TEXT,expires INTEGER); CREATE TABLE IF NOT EXISTS sync(teacherId TEXT PRIMARY KEY,at TEXT);`,
);
db.exec(
  "PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS teacher_links(teacherId TEXT PRIMARY KEY,personId TEXT NOT NULL,email TEXT,checkedAt TEXT); CREATE TABLE IF NOT EXISTS auto_accounts(subject TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,teacherId TEXT NOT NULL UNIQUE); CREATE TABLE IF NOT EXISTS service_state(key TEXT PRIMARY KEY,value TEXT);",
);
db.exec(`CREATE TABLE IF NOT EXISTS student_profiles(studentId TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS procedures(studentId TEXT, kind TEXT, data TEXT NOT NULL, PRIMARY KEY(studentId,kind));`);
const get = (sql, ...a) => db.prepare(sql).get(...a),
  all = (sql, ...a) => db.prepare(sql).all(...a),
  run = (sql, ...a) => db.prepare(sql).run(...a);
const token = () => randomBytes(32).toString("base64url"),
  hash = (s) => createHash("sha256").update(s).digest("hex");
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
  if (!managementHash) throw fail(503, "Пароль руководства ещё не настроен");
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
    throw fail(403, "Неверный пароль руководства");
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
    const valid =
      u.source === "ruz"
        ? all(
            "SELECT * FROM teacher_links WHERE email=? AND checkedAt>?",
            u.email,
            new Date(Date.now() - 7 * 86400000).toISOString(),
          ).length === 1 &&
          get(
            "SELECT 1 FROM teacher_links WHERE teacherId=? AND email=?",
            u.id,
            u.email,
          ) &&
          get(
            "SELECT 1 FROM auto_accounts WHERE subject=? AND email=? AND teacherId=?",
            u.subject,
            u.email,
            u.id,
          )
        : accounts.some(
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
    demo,
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
  if (role !== "teacher") checkManagementPassword(req);
  if (req.sessionKey) run("DELETE FROM sessions WHERE id=?", req.sessionKey);
  const user = { ...person, role, source: "selection" };
  session(res, { user, ...(role !== "teacher" ? { managementVersion } : {}) });
  res.json({ user });
});
app.post("/api/demo-login", (req, res) => {
  if (!demo) return res.sendStatus(404);
  const role = req.body.role;
  if (role === "admin") checkManagementPassword(req);
  const teacher = roster.teachers.find((t) => t.id === req.body.teacherId);
  if (role !== "admin" && !teacher) throw fail(400, "Выберите преподавателя");
  if (req.sessionKey) run("DELETE FROM sessions WHERE id=?", req.sessionKey);
  const user =
    role === "admin"
      ? { id: "demo_admin", name: "Руководство", role: "admin" }
      : { ...teacher, role: "teacher" };
  session(res, { user, ...(role === "admin" ? { managementVersion } : {}) });
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
  let account = accounts.find(
    (a) => a.email.toLowerCase() === email && a.subject === claims.sub,
  );
  if (
    !account &&
    process.env.AUTO_ENROLL_TEACHERS === "true" &&
    claims.email_verified === true &&
    /^[^\s@]+@hse\.ru$/.test(email)
  ) {
    const links = all(
      "SELECT * FROM teacher_links WHERE email=? AND checkedAt>?",
      email,
      new Date(Date.now() - 7 * 86400000).toISOString(),
    );
    if (links.length === 1) {
      const linked = get(
        "SELECT * FROM auto_accounts WHERE subject=? OR email=? OR teacherId=?",
        claims.sub,
        email,
        links[0].teacherId,
      );
      if (
        !linked ||
        (linked.subject === claims.sub &&
          linked.email === email &&
          linked.teacherId === links[0].teacherId)
      ) {
        run(
          "INSERT OR IGNORE INTO auto_accounts VALUES(?,?,?)",
          claims.sub,
          email,
          links[0].teacherId,
        );
        account = {
          role: "teacher",
          teacherId: links[0].teacherId,
          name: roster.teachers.find((t) => t.id === links[0].teacherId)?.name,
          source: "ruz",
        };
      }
    }
  }
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
      source: account.source || "explicit",
      subject: claims.sub,
    },
  });
  res.redirect("/");
});
app.use("/api", auth);
function lessonsFor(u, includeUnmatched = false) {
  return all(
    "SELECT data FROM lessons" +
      (u.role === "teacher" ? " WHERE teacherId=?" : ""),
    ...(u.role === "teacher" ? [u.id] : []),
  )
    .map((x) => JSON.parse(x.data))
    .filter((l) => includeUnmatched || lessonStudents(l).length > 0);
}
function ownedLesson(req) {
  const row = get("SELECT data FROM lessons WHERE id=?", req.params.id);
  if (!row) throw fail(404, "Занятие не найдено");
  const l = JSON.parse(row.data);
  if (
    req.session.user.role === "teacher" &&
    l.teacherId !== req.session.user.id
  )
    throw fail(403, "Это занятие другого преподавателя");
  if (!lessonStudents(l).length)
    throw fail(404, "Эта пара не относится к отслеживаемым студентам");
  return l;
}
function lessonStudents(l) {
  const ids = new Set(
    roster.enrollments
      .filter(
        (e) =>
          e.teacherId === l.teacherId &&
          e.course === l.course &&
          l.groups.includes(e.group),
      )
      .map((e) => e.studentId),
  );
  return roster.students
    .filter((s) => {
      if (!ids.has(s.id)) return false;
      const profile = studentProfile(s.id);
      return (
        profile.foreignStatus !== "excluded" &&
        (!profile.enrollmentStatus || profile.enrollmentStatus === "active")
      );
    })
    .sort((a, b) => a.name.localeCompare(b.name, "ru"));
}
function visibleMarks(lesson) {
  const ids = new Set(lessonStudents(lesson).map((s) => s.id));
  return all(
    "SELECT studentId,status,note FROM marks WHERE lessonId=?",
    lesson.id,
  ).filter((m) => ids.has(m.studentId));
}
app.get("/api/lessons", (req, res) =>
  res.json({
    lessons: prioritizeLessons(lessonsFor(req.session.user)).map((l) => ({
      ...l,
      studentCount: lessonStudents(l).length,
      marked: visibleMarks(l).length,
      version:
        get("SELECT version FROM revisions WHERE lessonId=?", l.id)?.version ||
        0,
    })),
    sync:
      req.session.user.role === "teacher"
        ? get("SELECT at FROM sync WHERE teacherId=?", req.session.user.id)
        : null,
  }),
);
app.get("/api/lessons/:id", (req, res) => {
  const l = ownedLesson(req);
  res.json({
    lesson: l,
    students: lessonStudents(l),
    marks: visibleMarks(l),
    version:
      get("SELECT version FROM revisions WHERE lessonId=?", l.id)?.version || 0,
  });
});
app.put("/api/lessons/:id/marks", (req, res) => {
  if (req.session.user.role === "office")
    throw fail(403, "Посещение отмечает преподаватель");
  const l = ownedLesson(req);
  if (new Date(`${l.date}T${l.start}:00+03:00`) > new Date())
    throw fail(400, "Занятие ещё не началось");
  const allowed = new Set(lessonStudents(l).map((s) => s.id)),
    items = req.body.marks;
  if (
    !Array.isArray(items) ||
    items.length > allowed.size ||
    items.some((x) => !x || typeof x !== "object") ||
    new Set(items.map((x) => x.studentId)).size !== items.length ||
    items.some(
      (x) =>
        !allowed.has(x.studentId) ||
        !(statuses.includes(x.status) || x.status === null) ||
        typeof x.note !== "string" ||
        x.note.length > 500,
    )
  )
    throw fail(400, "Проверьте отметки и состав студентов");
  db.exec("BEGIN IMMEDIATE");
  try {
    const version =
      get("SELECT version FROM revisions WHERE lessonId=?", l.id)?.version || 0;
    if (req.body.version !== version)
      throw fail(
        409,
        "Журнал изменился в другой вкладке. Обновите страницу перед сохранением.",
      );
    for (const x of items) {
      if (x.status === null)
        run(
          "DELETE FROM marks WHERE lessonId=? AND studentId=?",
          l.id,
          x.studentId,
        );
      else
        run(
          "INSERT OR REPLACE INTO marks VALUES(?,?,?,?,?)",
          l.id,
          x.studentId,
          x.status,
          x.note,
          new Date().toISOString(),
        );
    }
    run("INSERT OR REPLACE INTO revisions VALUES(?,?)", l.id, version + 1);
    audit(req.session.user, "attendance.update", l.id);
    db.exec("COMMIT");
    res.json({ version: version + 1, savedAt: new Date().toISOString() });
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
});
async function ruzFetch(path) {
  let response;
  try {
    response = await fetch("https://ruz.hse.ru/api/" + path, {
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw fail(502, "Не удалось связаться с РУЗ. Повтор запланирован.");
  }
  if (!response.ok)
    throw fail(502, "РУЗ временно недоступен. Сохранённый журнал доступен.");
  const text = await response.text();
  return parseRuzResponse(text, response.url);
}
const syncing = new Map();
async function performSync(tid, u = { name: "Автоматическое обновление" }) {
  const t = roster.teachers.find((t) => t.id === tid);
  if (!t) throw fail(400, "Выберите преподавателя");
  try {
    const cached = get(
      "SELECT personId FROM teacher_links WHERE teacherId=?",
      tid,
    );
    const people = cached
      ? [{ id: cached.personId, label: t.name }]
      : await ruzFetch("search?type=person&term=" + encodeURIComponent(t.name));
    const matches = people.filter((p) => p.label?.trim() === t.name);
    if (matches.length !== 1)
      throw fail(
        409,
        "В РУЗ нет единственного точного совпадения ФИО. Требуется ручное сопоставление.",
      );
    const today = moscowDate(),
      start = new Date(today + "T12:00:00Z"),
      end = new Date(start);
    start.setUTCDate(start.getUTCDate() - 7);
    end.setUTCDate(end.getUTCDate() + 7);
    const fmt = (d) => d.toISOString().slice(0, 10).replaceAll("-", ".");
    const entries = await loadTeacherSchedule(
      ruzFetch,
      t.name,
      matches[0].id,
      `start=${fmt(start)}&finish=${fmt(end)}&lng=1`,
    );
    const email = resolveTeacherEmail(entries, t.name);
    const received = entries.map((e) => ({
      id:
        "ruz_" +
        hash(
          [tid, e.lessonOid, e.date, e.beginLesson, e.groupOid].join("|"),
        ).slice(0, 24),
      teacherId: tid,
      date: e.date?.replaceAll(".", "-"),
      start: e.beginLesson,
      end: e.endLesson,
      course: e.discipline,
      kind: e.kindOfWork,
      room: e.auditorium || "",
      building: e.building || "",
      groups: [
        ...new Set(
          [...(e.listGroups || []).map((g) => g.group), e.group]
            .filter(Boolean)
            .map((g) => g.split("#")[0]),
        ),
      ],
      source: "ruz",
    }));
    if (
      received.some(
        (l) =>
          !/^\d{4}-\d{2}-\d{2}$/.test(l.date) ||
          !/^\d{2}:\d{2}$/.test(l.start) ||
          !/^\d{2}:\d{2}$/.test(l.end) ||
          !l.course,
      )
    )
      throw fail(502, "Не удалось проверить формат расписания РУЗ");
    const normalized = received.filter((l) => lessonStudents(l).length > 0);
    db.exec("BEGIN");
    try {
      const ids = new Set(normalized.map((l) => l.id));
      for (const old of lessonsFor({ id: tid, role: "teacher" }, true)) {
        if (
          old.date >= fmt(start).replaceAll(".", "-") &&
          old.date <= fmt(end).replaceAll(".", "-") &&
          !ids.has(old.id)
        ) {
          if (!get("SELECT 1 FROM marks WHERE lessonId=?", old.id))
            run("DELETE FROM lessons WHERE id=?", old.id);
          else
            run(
              "UPDATE lessons SET data=? WHERE id=?",
              JSON.stringify({ ...old, scheduleRemoved: true }),
              old.id,
            );
        }
      }
      for (const l of normalized)
        run(
          "INSERT OR REPLACE INTO lessons VALUES(?,?,?)",
          l.id,
          tid,
          JSON.stringify(l),
        );
      run(
        "INSERT OR REPLACE INTO teacher_links VALUES(?,?,?,?)",
        tid,
        String(matches[0].id),
        email,
        new Date().toISOString(),
      );
      run(
        "INSERT OR REPLACE INTO sync VALUES(?,?)",
        tid,
        new Date().toISOString(),
      );
      audit(u, "ruz.sync", tid);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    return {
      count: normalized.length,
      matched: normalized.filter((l) => lessonStudents(l).length).length,
    };
  } catch (e) {
    throw e;
  }
}
function syncTeacher(tid, u) {
  if (syncing.has(tid)) return syncing.get(tid);
  const pending = performSync(tid, u).finally(() => syncing.delete(tid));
  syncing.set(tid, pending);
  return pending;
}
const scheduler = createScheduler({
  db,
  teacherIds: roster.teachers.map((t) => t.id),
  syncTeacher,
  intervalMs:
    Math.max(15, Number(process.env.SYNC_INTERVAL_MINUTES) || 360) * 60000,
});
app.post("/api/ruz/sync", async (req, res) => {
  const u = req.session.user,
    tid = u.role === "teacher" ? u.id : req.body.teacherId;
  if (typeof tid !== "string" || !roster.teachers.some((t) => t.id === tid))
    throw fail(400, "Выберите преподавателя");
  const previous = get("SELECT at FROM sync WHERE teacherId=?", tid);
  if (previous && Date.now() - Date.parse(previous.at) < 60000)
    return res.json({
      cached: true,
      count: lessonsFor({ id: tid, role: "teacher" }).length,
    });
  const result = await syncTeacher(tid, u);
  scheduler.success(tid);
  res.json(result);
});
app.use("/api/admin", admin);
app.get("/api/admin/automation", (req, res) => {
  const jobs = scheduler.state(),
    links = all("SELECT * FROM teacher_links");
  res.json({
    enabled: process.env.AUTO_SYNC === "true",
    intervalMinutes: Math.max(
      15,
      Number(process.env.SYNC_INTERVAL_MINUTES) || 360,
    ),
    total: jobs.length,
    synced: jobs.filter((j) => j.lastSuccess).length,
    failed: jobs.filter((j) => j.error).length,
    pending: jobs.filter((j) => !j.lastSuccess && !j.error).length,
    linkedEmails: links.filter((l) => l.email).length,
    backup: get("SELECT value FROM service_state WHERE key='backup'"),
    issues: jobs
      .filter((j) => j.error)
      .map((j) => ({
        ...j,
        name: roster.teachers.find((t) => t.id === j.teacherId)?.name,
      })),
  });
});
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
  const rows = all("SELECT kind,data FROM procedures WHERE studentId=?", id);
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
    return { ...c, ...record, status: procedureStatus(record, moscowDate()) };
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
  } = req.body;
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
  const lessons = all("SELECT data FROM lessons").map((x) =>
      JSON.parse(x.data),
    ),
    map = new Map(lessons.map((l) => [l.id, l]));
  const marks = all("SELECT * FROM marks").map((m) => ({
    ...m,
    ...map.get(m.lessonId),
  }));
  const debts = all("SELECT * FROM debts");
  return roster.students.map((s) => ({
    ...studentProfile(s.id),
    manager: managerFor(studentProfile(s.id)),
    procedureOverdue: proceduresFor(s.id).filter((p) =>
      ["overdue", "expired"].includes(p.status),
    ).length,
    procedureUnknown: proceduresFor(s.id).filter((p) => p.status === "unknown")
      .length,
    procedureReview: proceduresFor(s.id).filter((p) => p.status === "submitted")
      .length,
    groups: [
      ...new Set(
        roster.enrollments
          .filter((e) => e.studentId === s.id)
          .map((e) => e.group),
      ),
    ],
    ...studentMetrics(
      marks.filter((m) => m.studentId === s.id),
      debts.filter((d) => d.studentId === s.id),
    ),
  }));
}
app.get("/api/admin/overview", (req, res) => {
  const students = studentRows(),
    lessons = lessonsFor(req.session.user);
  const lessonIds = new Set(lessons.map((l) => l.id)),
    studentIds = new Set(roster.students.map((s) => s.id));
  const scopedMarks = all(
    "SELECT m.*,json_extract(l.data,'$.date') date FROM marks m JOIN lessons l ON l.id=m.lessonId",
  ).filter((m) => lessonIds.has(m.lessonId) && studentIds.has(m.studentId));
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
    lessons: lessons.length,
    markedLessons: new Set(scopedMarks.map((m) => m.lessonId)).size,
    attendance: studentMetrics(scopedMarks, []).attendance,
    audit: all("SELECT * FROM audit ORDER BY id DESC LIMIT 12"),
  });
});
app.get("/api/admin/students/:id", (req, res) => {
  const student = studentRows().find((s) => s.id === req.params.id);
  if (!student) throw fail(404, "Студент не найден");
  res.json({
    student,
    canEdit: canEditStudent(req.session.user, student),
    programs,
    procedures: proceduresFor(student.id),
    records: all(
      "SELECT m.*,l.data FROM marks m JOIN lessons l ON l.id=m.lessonId WHERE m.studentId=? ORDER BY json_extract(l.data,'$.date') DESC",
      student.id,
    ).map((r) => ({ ...r, lesson: JSON.parse(r.data), data: undefined })),
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
  const esc = (v) =>
    '"' +
    String(v ?? "")
      .replace(/^[=+@\-]/, "'$&")
      .replaceAll('"', '""') +
    '"';
  const rows = studentRows().map((s) => [
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
          "7 дней без явки",
          "7 дней и учебная задолженность (архив)",
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
if (process.env.AUTO_SYNC === "true") scheduler.start();
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
  scheduler.stop();
  clearInterval(backupTimer);
  server.close(async () => {
    await Promise.allSettled([...syncing.values()]);
    while (backupRunning) await new Promise((r) => setTimeout(r, 50));
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 30000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
