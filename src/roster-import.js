// Обновление реестра из нового файла Excel «студенты – группы – преподаватели».
// planImport ничего не пишет и показывает, что изменится; applyImport применяет план.
import { readWorkbook } from "./xlsx.js";
import { rosterId, studentId } from "./domain.js";

const clean = (v) =>
  String(v ?? "")
    .trim()
    .replace(/\s+/g, " ");
const norm = (n) => clean(n).toLocaleLowerCase("ru").replace(/ё/g, "е");
const plain = (n) => (n.startsWith("Вак_") ? n.slice(4) : n);
const enrollmentKey = (e) =>
  [e.studentId, e.teacherId, e.group, e.course].join("\n");

// Лист «База»: группа, преподаватель, студент, дисциплина, вид занятий. Строки без первых четырёх колонок пропускаются.
export function parseRoster(buffer) {
  const sheets = readWorkbook(buffer);
  const base = sheets["База"];
  if (!base)
    throw Object.assign(new Error("В файле нет листа «База»"), { status: 400 });
  const rows = base
    .slice(1)
    .filter((r) => r && [0, 1, 2, 3].every((i) => clean(r[i])))
    .map((r) => ({
      group: clean(r[0]),
      teacher: clean(r[1]),
      student: clean(r[2]),
      course: clean(r[3]),
      kind: clean(r[4]),
    }));
  if (!rows.length)
    throw Object.assign(new Error("На листе «База» нет строк"), {
      status: 400,
    });
  const count = (name) => Math.max(0, (sheets[name]?.length || 1) - 1);
  return {
    rows,
    quality: {
      sourceRows: rows.length,
      unresolved: count("Не определены"),
      mismatches: count("Несовпадения"),
    },
  };
}

// Совпадение по ФИО (без учёта регистра и «ё»), «Вак_Иванов» и «Иванов» – один человек.
// Связи из прежних файлов у студентов, которые есть в новом файле, заменяются на связи из файла;
// ручные связи и студенты, которых в файле нет, не трогаются.
export function planImport(roster, { rows, quality }) {
  const teachersByName = new Map(
    roster.teachers.map((t) => [norm(plain(t.name)), t]),
  );
  const studentsByName = new Map(roster.students.map((s) => [norm(s.name), s]));
  const fileNames = new Set(rows.map((r) => r.teacher));
  const newTeachers = new Map(),
    newStudents = new Map();
  // «Вак_Иванов» с одной фамилией: единственный однофамилец в базе, а при нескольких – тот, кто ведёт ту же дисциплину.
  const coursesByTeacher = new Map();
  for (const e of roster.enrollments)
    (
      coursesByTeacher.get(e.teacherId) ||
      coursesByTeacher.set(e.teacherId, new Set()).get(e.teacherId)
    ).add(e.course);
  const bySurname = (surname, courses) => {
    const found = roster.teachers.filter(
      (t) => norm(t.name.split(" ")[0]) === norm(surname),
    );
    const sharing = found.filter((t) =>
      [...courses].some((c) => coursesByTeacher.get(t.id)?.has(c)),
    );
    return (
      (sharing.length === 1 && sharing[0]) ||
      (found.length === 1 && found[0]) ||
      null
    );
  };
  const fileCourses = new Map();
  for (const r of rows)
    (
      fileCourses.get(r.teacher) ||
      fileCourses.set(r.teacher, new Set()).get(r.teacher)
    ).add(r.course);
  const resolveTeacher = (raw) => {
    const name =
      raw.startsWith("Вак_") && fileNames.has(raw.slice(4))
        ? raw.slice(4)
        : raw;
    const k = norm(plain(name));
    if (teachersByName.has(k)) return teachersByName.get(k);
    if (!plain(name).includes(" ")) {
      const t = bySurname(plain(name), fileCourses.get(raw) || new Set());
      if (t) return t;
    }
    if (!newTeachers.has(k))
      newTeachers.set(k, { id: rosterId("t_", name), name });
    return newTeachers.get(k);
  };
  const resolveStudent = (name) => {
    const k = norm(name);
    if (studentsByName.has(k)) return studentsByName.get(k);
    if (!newStudents.has(k)) newStudents.set(k, { id: studentId(name), name });
    return newStudents.get(k);
  };
  const wanted = new Map(),
    studentsInFile = new Set();
  for (const r of rows) {
    const t = resolveTeacher(r.teacher),
      s = resolveStudent(r.student);
    studentsInFile.add(s.id);
    for (const g of r.group.split(";")) {
      const e = {
        studentId: s.id,
        teacherId: t.id,
        group: g.trim(),
        course: r.course,
        kind: r.kind,
      };
      wanted.set(enrollmentKey(e), e);
    }
  }
  const existing = new Set(roster.enrollments.map(enrollmentKey));
  const add = [...wanted.values()].filter(
    (e) => !existing.has(enrollmentKey(e)),
  );
  const remove = roster.enrollments.filter(
    (e) =>
      studentsInFile.has(e.studentId) &&
      e.kind !== "ручной ввод" &&
      !wanted.has(enrollmentKey(e)),
  );
  return {
    students: {
      add: [...newStudents.values()],
      missing: roster.students
        .filter((s) => !studentsInFile.has(s.id))
        .map((s) => s.name),
    },
    teachers: { add: [...newTeachers.values()] },
    enrollments: { add, remove },
    quality,
    studentsInFile: studentsInFile.size,
  };
}

export function applyImport({ run, roster, addEnrollment }, plan) {
  for (const s of plan.students.add) {
    run("INSERT INTO roster_students VALUES(?,?)", s.id, s.name);
    roster.students.push({ id: s.id, name: s.name });
  }
  for (const t of plan.teachers.add) {
    run("INSERT INTO roster_teachers VALUES(?,?)", t.id, t.name);
    roster.teachers.push({ id: t.id, name: t.name });
  }
  for (const e of plan.enrollments.remove)
    run(
      "DELETE FROM roster_enrollments WHERE studentId=? AND teacherId=? AND grp=? AND course=?",
      e.studentId,
      e.teacherId,
      e.group,
      e.course,
    );
  const removed = new Set(plan.enrollments.remove.map(enrollmentKey));
  roster.enrollments = roster.enrollments.filter(
    (e) => !removed.has(enrollmentKey(e)),
  );
  for (const e of plan.enrollments.add) {
    addEnrollment(e);
    roster.enrollments.push(e);
  }
  const quality = { ...plan.quality, importedAt: new Date().toISOString() };
  run(
    "INSERT OR REPLACE INTO service_state VALUES('rosterQuality',?)",
    JSON.stringify(quality),
  );
  roster.quality = quality;
}
