import { moscowDate } from "./domain.js";
import { validDate } from "./office.js";

export function summarizeAttendance(students, records, from, to) {
  return students.map((s) => {
    const history = records
      .filter((r) => r.studentId === s.id && r.date >= from && r.date <= to)
      .sort((a, b) => b.date.localeCompare(a.date));
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
      daysPresent: new Set(visits.map((r) => r.date)).size,
      history,
    };
  });
}

export function registerDaily(
  app,
  { db, roster, auth, admin, studentProfile, audit },
) {
  db.exec(`CREATE TABLE IF NOT EXISTS daily_marks(teacherId TEXT,date TEXT,studentId TEXT,status TEXT,updatedAt TEXT,PRIMARY KEY(teacherId,date,studentId));
    CREATE TABLE IF NOT EXISTS daily_revisions(teacherId TEXT,date TEXT,version INTEGER,PRIMARY KEY(teacherId,date));`);
  const fail = (status, message) =>
    Object.assign(new Error(message), { status });
  const active = (s) =>
    s.foreignStatus !== "excluded" &&
    (!s.enrollmentStatus || s.enrollmentStatus === "active");
  const studentsFor = (id) => {
    const ids = new Set(
      roster.enrollments
        .filter((e) => e.teacherId === id)
        .map((e) => e.studentId),
    );
    return roster.students
      .map((s) => studentProfile(s.id))
      .filter((s) => ids.has(s.id) && active(s))
      .sort((a, b) => a.name.localeCompare(b.name, "ru"));
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
  const version = (id, date) =>
    db
      .prepare(
        "SELECT version FROM daily_revisions WHERE teacherId=? AND date=?",
      )
      .get(id, date)?.version || 0;
  app.get("/api/daily", auth, (req, res) => {
    const id = teacher(req),
      date = req.query.date || moscowDate();
    checkDate(date);
    const students = studentsFor(id),
      ids = new Set(students.map((s) => s.id));
    res.json({
      date,
      version: version(id, date),
      students,
      marks: db
        .prepare(
          "SELECT studentId,status FROM daily_marks WHERE teacherId=? AND date=?",
        )
        .all(id, date)
        .filter((m) => ids.has(m.studentId)),
    });
  });
  app.put("/api/daily", auth, (req, res) => {
    const id = teacher(req),
      { date, marks, version: expected } = req.body;
    checkDate(date);
    const ids = new Set(studentsFor(id).map((s) => s.id));
    if (
      !Array.isArray(marks) ||
      marks.length > ids.size ||
      new Set(marks.map((m) => m?.studentId)).size !== marks.length ||
      !Number.isInteger(expected)
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
      if (version(id, date) !== expected)
        throw fail(
          409,
          "Отметки уже изменены в другом окне. Перезагрузите дату перед повторным сохранением.",
        );
      for (const m of marks) {
        if (m.status === null)
          db.prepare(
            "DELETE FROM daily_marks WHERE teacherId=? AND date=? AND studentId=?",
          ).run(id, date, m.studentId);
        else
          db.prepare(
            "INSERT OR REPLACE INTO daily_marks VALUES(?,?,?,?,?)",
          ).run(id, date, m.studentId, m.status, new Date().toISOString());
      }
      db.prepare("INSERT OR REPLACE INTO daily_revisions VALUES(?,?,?)").run(
        id,
        date,
        expected + 1,
      );
      audit(req.session.user, "daily.save", id + ":" + date);
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
    const records = db.prepare("SELECT * FROM daily_marks").all();
    // Исторические отметки по занятиям сохраняются в общей истории.
    for (const r of db
      .prepare(
        "SELECT m.studentId,m.status,l.teacherId,json_extract(l.data,'$.date') date FROM marks m JOIN lessons l ON l.id=m.lessonId WHERE m.status IN ('present','absent')",
      )
      .all())
      records.push({ ...r, source: "lesson" });
    const names = new Map(roster.teachers.map((t) => [t.id, t.name]));
    return {
      from,
      to,
      students: summarizeAttendance(
        roster.students.map((s) => studentProfile(s.id)).filter(active),
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
        present: "Был хотя бы раз",
        absent: "Присутствие не отмечено",
        unknown: "Нет данных",
      };
    const cell = (x) =>
      '"' +
      String(x ?? "")
        .replace(/^[\s]*[=+@-]/, "'$&")
        .replaceAll('"', '""') +
      '"';
    const rows = [
      [
        "Студент",
        "Период с",
        "Период по",
        "Результат",
        "Дней с присутствием",
        "Последнее посещение",
        "История",
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
              `${r.date}: ${r.teacher}: ${r.status === "present" ? "Был" : "Не был"}`,
          )
          .join(" | "),
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
