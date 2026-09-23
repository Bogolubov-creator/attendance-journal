import { csvCell } from "./csv.js";
import { moscowDate, ruCompare, studentMetrics } from "./domain.js";
import { canSeeStudent, validDate } from "./office.js";

export function summarizeAttendance(
  students,
  records,
  from,
  to,
  today = moscowDate(),
) {
  return students.map((s) => {
    const history = records
      .filter((r) => r.studentId === s.id && r.date >= from && r.date <= to)
      .sort((a, b) => b.date.localeCompare(a.date));
    const current = studentMetrics(
      records.filter((r) => r.studentId === s.id),
      [],
      today,
    );
    const visits = history.filter((r) => r.status === "present");
    return {
      ...s,
      status: visits.length ? "present" : history.length ? "absent" : "unknown",
      lastVisit:
        records
          .filter((r) => r.studentId === s.id && r.status === "present")
          .map((r) => r.date)
          .sort()
          .at(-1) || null,
      absenceDays: current.days,
      absenceAlert: current.absenceAlert,
      daysPresent: new Set(visits.map((r) => r.date)).size,
      history,
    };
  });
}

// Все ответы преподавателей: дневные отметки и исторические отметки по занятиям.
// С studentId – только этого студента: чтение всей таблицы отметок дорого.
// brief – без времени правки: реестру оно не нужно, а чтение заметно быстрее.
export function attendanceRecords(db, studentId, brief = false) {
  const one = studentId !== undefined,
    args = one ? [studentId] : [];
  const records = db
    .prepare(
      `SELECT ${brief ? "teacherId,date,course,studentId,status" : "*"} FROM daily_marks` +
        (one ? " WHERE studentId=?" : ""),
    )
    .all(...args);
  for (const r of db
    .prepare(
      "SELECT m.studentId,m.status,l.teacherId,json_extract(l.data,'$.date') date,json_extract(l.data,'$.course') course FROM marks m JOIN lessons l ON l.id=m.lessonId WHERE m.status IN ('present','absent')" +
        (one ? " AND m.studentId=?" : ""),
    )
    .all(...args))
    records.push({ ...r, source: "lesson" });
  return records;
}

export function registerDaily(
  app,
  { db, roster, auth, admin, studentProfile, audit },
) {
  // Отметка привязана к дисциплине. Таблицы прежней версии переименовываются, записи переносятся с пустой дисциплиной.
  const columns = db.prepare("PRAGMA table_info(daily_marks)").all();
  if (columns.length && !columns.some((c) => c.name === "course"))
    db.exec(
      "ALTER TABLE daily_marks RENAME TO daily_marks_v1; ALTER TABLE daily_revisions RENAME TO daily_revisions_v1;",
    );
  db.exec(`CREATE TABLE IF NOT EXISTS daily_marks(teacherId TEXT,date TEXT,course TEXT,studentId TEXT,status TEXT,updatedAt TEXT,PRIMARY KEY(teacherId,date,course,studentId));
    CREATE TABLE IF NOT EXISTS daily_revisions(teacherId TEXT,date TEXT,course TEXT,version INTEGER,PRIMARY KEY(teacherId,date,course));`);
  if (columns.length && !columns.some((c) => c.name === "course"))
    db.exec(
      "INSERT OR IGNORE INTO daily_marks SELECT teacherId,date,'',studentId,status,updatedAt FROM daily_marks_v1; INSERT OR IGNORE INTO daily_revisions SELECT teacherId,date,'',version FROM daily_revisions_v1;",
    );
  const fail = (status, message) =>
    Object.assign(new Error(message), { status });
  const active = (s) =>
    s.foreignStatus !== "excluded" &&
    (!s.enrollmentStatus || s.enrollmentStatus === "active");
  const coursesFor = (id) =>
    [
      ...new Set(
        roster.enrollments
          .filter((e) => e.teacherId === id)
          .map((e) => e.course),
      ),
    ].sort(ruCompare);
  const studentsFor = (id, course) => {
    const ids = new Set(
      roster.enrollments
        .filter((e) => e.teacherId === id && e.course === course)
        .map((e) => e.studentId),
    );
    return roster.students
      .map((s) => studentProfile(s.id))
      .filter((s) => ids.has(s.id) && active(s))
      .map(({ id, name }) => ({ id, name }))
      .sort((a, b) => ruCompare(a.name, b.name));
  };
  const checkDate = (date) => {
    if (!date || !validDate(date) || date > moscowDate())
      throw fail(400, "Выберите корректную дату не позднее сегодняшней");
  };
  const teacher = (req) => {
    if (req.session.user.role !== "teacher")
      throw fail(403, "Отметки заполняет преподаватель");
    return req.session.user.id;
  };
  const checkCourse = (id, course) => {
    if (typeof course !== "string" || !coursesFor(id).includes(course))
      throw fail(400, "Выберите дисциплину из своего списка");
  };
  const version = (id, date, course) =>
    db
      .prepare(
        "SELECT version FROM daily_revisions WHERE teacherId=? AND date=? AND course=?",
      )
      .get(id, date, course)?.version || 0;
  app.get("/api/daily", auth, (req, res) => {
    const id = teacher(req),
      date = req.query.date || moscowDate(),
      courses = coursesFor(id),
      course = req.query.course ?? courses[0] ?? "";
    checkDate(date);
    if (courses.length) checkCourse(id, course);
    const students = studentsFor(id, course),
      ids = new Set(students.map((s) => s.id));
    res.json({
      date,
      course,
      courses,
      version: version(id, date, course),
      students,
      marks: db
        .prepare(
          "SELECT studentId,status FROM daily_marks WHERE teacherId=? AND date=? AND course=?",
        )
        .all(id, date, course)
        .filter((m) => ids.has(m.studentId)),
    });
  });
  app.put("/api/daily", auth, (req, res) => {
    const id = teacher(req),
      { date, course, marks, version: expected } = req.body;
    checkDate(date);
    checkCourse(id, course);
    const ids = new Set(studentsFor(id, course).map((s) => s.id));
    if (
      !Array.isArray(marks) ||
      marks.length > ids.size ||
      new Set(marks.map((m) => m?.studentId)).size !== marks.length ||
      !Number.isSafeInteger(expected) ||
      expected < 0
    )
      throw fail(400, "Некорректные отметки");
    if (
      marks.some(
        (m) =>
          !m ||
          !ids.has(m.studentId) ||
          !["present", "absent", null].includes(m.status),
      )
    )
      throw fail(400, "Проверьте список студентов и отметки");
    db.exec("BEGIN IMMEDIATE");
    try {
      if (version(id, date, course) !== expected)
        throw fail(
          409,
          "Отметки уже изменены в другом окне. Перезагрузите дату перед повторным сохранением.",
        );
      for (const m of marks) {
        if (m.status === null)
          db.prepare(
            "DELETE FROM daily_marks WHERE teacherId=? AND date=? AND course=? AND studentId=?",
          ).run(id, date, course, m.studentId);
        else
          db.prepare(
            "INSERT OR REPLACE INTO daily_marks VALUES(?,?,?,?,?,?)",
          ).run(
            id,
            date,
            course,
            m.studentId,
            m.status,
            new Date().toISOString(),
          );
      }
      db.prepare("INSERT OR REPLACE INTO daily_revisions VALUES(?,?,?,?)").run(
        id,
        date,
        course,
        expected + 1,
      );
      audit(req.session.user, "daily.save", id + ":" + date + ":" + course);
      db.exec("COMMIT");
      res.json({ ok: true, version: expected + 1 });
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  });
  function overview(req) {
    const from = req.query.from || moscowDate(),
      to = req.query.to || moscowDate();
    checkDate(from);
    checkDate(to);
    if (from > to)
      throw fail(400, "Начало периода должно быть не позже окончания");
    const records = attendanceRecords(db);
    const names = new Map(roster.teachers.map((t) => [t.id, t.name]));
    return {
      from,
      to,
      alertAsOf: moscowDate(),
      students: summarizeAttendance(
        roster.students
          .map((s) => studentProfile(s.id))
          .filter(active)
          .filter((s) => canSeeStudent(req.session.user, s)),
        records.map((r) => ({
          ...r,
          teacher: names.get(r.teacherId) || "Преподаватель",
        })),
        from,
        to,
      ),
    };
  }
  app.get("/api/daily/overview", auth, admin, (req, res) =>
    res.json(overview(req)),
  );
  app.get("/api/daily/export", auth, admin, (req, res) => {
    const data = overview(req),
      labels = {
        present: "Присутствовал(а) хотя бы раз",
        absent: "Отсутствуют",
        unknown: "Нет данных",
      };
    const cell = csvCell;
    const rows = [
      [
        "Студент",
        "Период с",
        "Период по",
        "Результат",
        "Дней с присутствием",
        "Последнее посещение",
        "История",
        "Учебных дней без явки на сегодня",
        "Тревога на сегодня: больше 7 учебных дней",
      ],
      ...data.students.map((s) => [
        s.name,
        data.from,
        data.to,
        labels[s.status],
        s.daysPresent,
        s.lastVisit,
        s.history
          .map(
            (r) =>
              `${r.date}: ${r.teacher}${r.course ? ": " + r.course : ""}: ${r.status === "present" ? "Присутствовал(а)" : "Отсутствовал(а)"}`,
          )
          .join(" | "),
        s.absenceDays,
        s.absenceAlert ? "Да" : "Нет",
      ]),
    ];
    res
      .set({
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="attendance-period.csv"',
      })
      .send("\uFEFF" + rows.map((r) => r.map(cell).join(";")).join("\r\n"));
  });
}
