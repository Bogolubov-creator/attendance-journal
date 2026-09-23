import {
  pickStudentFields,
  studentEditableFields,
  validDate,
} from "./office.js";

// Допустимые значения для полей, которые студент правит сам. Правила те же,
// что использует сотруднический маршрут PUT /api/admin/students/:id/profile
// (src/server.js) – дублировать его целиком незачем, но значения должны
// совпадать.
const validHousing = ["", "dormitory", "private"];
const validInRussia = ["", "yes", "no"];
const validResidence = [
  "",
  "visa",
  "visa_free",
  "rvp",
  "rvpo",
  "residence_permit",
  "other",
];
// Проверяется только то, что студент прислал в теле запроса – отсутствующее
// поле сохраняет прежнее значение (см. pickStudentFields).
function validStudentEdit(body) {
  return (
    (!("citizenship" in body) ||
      (typeof body.citizenship === "string" &&
        body.citizenship.length <= 100)) &&
    (!("nameLatin" in body) ||
      (typeof body.nameLatin === "string" && body.nameLatin.length <= 200)) &&
    (!("sendingCountry" in body) ||
      (typeof body.sendingCountry === "string" &&
        body.sendingCountry.length <= 200)) &&
    (!("housing" in body) || validHousing.includes(body.housing)) &&
    (!("inRussia" in body) || validInRussia.includes(body.inRussia)) &&
    (!("residence" in body) || validResidence.includes(body.residence)) &&
    (!("arrivalDate" in body) || validDate(body.arrivalDate)) &&
    (!("passportUntil" in body) || validDate(body.passportUntil)) &&
    (!("migrationCardUntil" in body) || validDate(body.migrationCardUntil))
  );
}

export function registerStudent(app, { db, studentProfile, audit }) {
  const fail = (status, message) =>
    Object.assign(new Error(message), { status });
  const run = (sql, ...a) => db.prepare(sql).run(...a);
  // У свежеимпортированного студента строки в student_profiles ещё нет.
  const emptyProfile = {
    version: 0,
    program: "",
    year: 0,
    foreignStatus: "unknown",
    enrollmentStatus: "active",
    ...Object.fromEntries(studentEditableFields.map((field) => [field, ""])),
  };
  const cardFor = (id) => ({ ...emptyProfile, ...studentProfile(id) });
  // Идентификатор берётся из сессии: обработчик чужой id получить не может,
  // даже если он придёт в теле запроса.
  const onlyStudent = (req, res, next) => {
    if (req.session.user.role !== "student")
      return res.status(403).json({ error: "Раздел личного кабинета" });
    req.studentId = req.session.user.studentId;
    next();
  };
  app.get("/api/student/profile", onlyStudent, (req, res) =>
    res.json({
      student: cardFor(req.studentId),
      editable: studentEditableFields,
    }),
  );
  app.put("/api/student/profile", onlyStudent, (req, res) => {
    if (
      typeof req.body !== "object" ||
      req.body === null ||
      Array.isArray(req.body)
    )
      throw fail(400, "Некорректные данные");
    if (!validStudentEdit(req.body))
      throw fail(400, "Проверьте сведения о проживании и сроки документов");
    const previous = cardFor(req.studentId);
    if (req.body.version !== (previous.version || 0))
      throw fail(409, "Данные изменены. Откройте страницу заново");
    const data = {
      ...pickStudentFields(req.body, previous),
      version: (previous.version || 0) + 1,
    };
    data.citizenship = (data.citizenship || "").trim();
    data.nameLatin = (data.nameLatin || "").trim();
    data.sendingCountry = (data.sendingCountry || "").trim();
    delete data.id;
    delete data.name;
    run(
      "INSERT OR REPLACE INTO student_profiles VALUES(?,?)",
      req.studentId,
      JSON.stringify(data),
    );
    audit(req.session.user, "student.profile", req.studentId);
    res.json({ ok: true, version: data.version });
  });
}
