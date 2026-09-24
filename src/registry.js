import express from "express";
import { randomBytes } from "node:crypto";
import { parseRoster, planImport, applyImport } from "./roster-import.js";
import {
  managers,
  programs,
  directorySource,
  managerFor,
  canEditStudent,
  canSeeStudent,
  studentFieldsValid,
} from "./office.js";
import { studentId } from "./domain.js";

// Реестр: справочник, импорт Excel, перевод на следующий курс, добавление,
// переименование и удаление студентов и преподавателей, связи
// «студент – преподаватель – дисциплина», список студентов без учётной записи ВШЭ.
export function registerRegistry(
  app,
  { db, get, all, run, roster, addEnrollment, audit, fail, studentProfile },
) {
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
      if (req.query.apply !== "1")
        return res.json({ preview: true, ...summary });
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
      throw fail(
        403,
        "Менеджер меняет только студентов своих программ и курсов",
      );
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
}
