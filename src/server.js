import { csvCell } from "./csv.js";
import { registerDaily, attendanceRecords } from "./daily.js";
import { registerStudent } from "./student.js";
import { attachmentPath, attachmentLabel } from "./attachments.js";
import { loadAccounts, registerAuth } from "./auth.js";
import { registerRegistry } from "./registry.js";
import express from "express";
import {
  programs,
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
  foreignStatuses,
} from "./office.js";
import { openDatabase } from "./db.js";
import { rmSync } from "node:fs";
import { startBackups } from "./backup.js";
import { moscowDate, ruCompare, studentMetrics } from "./domain.js";
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
const { db, get, all, run, addEnrollment } = openDatabase({ demo, roster });
// Куда складываются сканы студентов; читается один раз здесь, маршруты получают путь готовым.
const uploadDir = process.env.UPLOAD_DIR || "data/uploads";
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
const accounts = loadAccounts({ demo, selection });
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
const { auth, admin } = registerAuth(app, {
  get,
  run,
  roster,
  demo,
  demoStudentLogin,
  selection,
  origin,
  accounts,
  fail,
  cabinetOpen,
  studentByExternalId,
});
app.get("/healthz", (req, res) => {
  get("SELECT 1");
  res.json({ ok: true });
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
registerRegistry(app, {
  db,
  get,
  all,
  run,
  roster,
  addEnrollment,
  audit,
  fail,
  studentProfile,
});
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
    !foreignStatuses.includes(foreignStatus) ||
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
  const records = groupBy(
      attendanceRecords(db, { studentId: only, brief: true }),
      "studentId",
    ),
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
      // Где и на каких занятиях был студент: новые отметки сверху. Для всего реестра
      // (обзор, CSV) – только число: список весит мегабайты, интерфейс берёт его из
      // карточки при раскрытии строки.
      ...(only === undefined
        ? { recordCount: own.length }
        : {
            records: own
              .sort((a, b) => b.date.localeCompare(a.date))
              .map((r) => ({
                date: r.date,
                course: r.course,
                teacher: teacherNames.get(r.teacherId),
                status: r.status,
              })),
          }),
    };
  });
}
app.get("/api/admin/overview", (req, res) => {
  const students = studentRows().filter((s) =>
    canSeeStudent(req.session.user, s),
  );
  res.json({
    // Реестру из менеджера нужны id и имя, группы он не читает – без них ответ легче.
    students: students.map(({ groups, ...s }) => ({
      ...s,
      manager: s.manager && { id: s.manager.id, name: s.manager.name },
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
// Файлы интерфейса браузер переспрашивает по ETag (304 без тела);
// всё остальное остаётся no-store из общей прослойки.
app.use(
  express.static("public", {
    setHeaders: (res) => res.set("Cache-Control", "no-cache"),
  }),
);
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
startBackups(server, { db, run });
