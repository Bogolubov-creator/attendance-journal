import {
  canSeeStudent,
  pickStudentFields,
  procedureCatalog,
  studentEditableFields,
  studentFieldsError,
  studentFieldsValid,
  validDate,
} from "./office.js";
import { moscowDate } from "./domain.js";
import { attendanceRecords, summarizeAttendance } from "./daily.js";
import {
  detectType,
  saveAttachment,
  attachmentPath,
  attachmentLabel,
} from "./attachments.js";
import express from "express";
import { randomBytes } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";

export function registerStudent(
  app,
  { db, studentProfile, audit, proceduresFor, uploadDir },
) {
  const fail = (status, message) =>
    Object.assign(new Error(message), { status });
  const run = (sql, ...a) => db.prepare(sql).run(...a);
  const get = (sql, ...a) => db.prepare(sql).get(...a);
  const all = (sql, ...a) => db.prepare(sql).all(...a);
  // Присланное студентом имя только показывается при скачивании – в путь на диске оно не попадает.
  const cleanName = (raw) => {
    let decoded;
    try {
      decoded = decodeURIComponent(raw || "файл");
    } catch {
      decoded = "файл";
    }
    const cleaned = decoded.replace(/[\u0000-\u001f/\\]/g, " ").trim();
    // slice() режет по UTF-16 code unit и может разорвать эмодзи из
    // суррогатной пары – Array.from делит строку по code points, поэтому
    // символ либо попадает в имя целиком, либо не попадает совсем.
    return Array.from(cleaned).slice(0, 200).join("") || "файл";
  };
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
    // Проверяются только присланные поля из белого списка студента –
    // отсутствующее поле сохраняет прежнее значение, чужое отбрасывается.
    if (!studentFieldsValid(pickStudentFields(req.body, {})))
      throw fail(400, studentFieldsError);
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
  app.get("/api/student/attendance", onlyStudent, (req, res) => {
    const from = req.query.from || moscowDate(),
      to = req.query.to || moscowDate();
    if (![from, to].every(validDate) || from > to)
      throw fail(400, "Проверьте период");
    const own = attendanceRecords(db, req.studentId);
    const [summary] = summarizeAttendance(
      [studentProfile(req.studentId)],
      own,
      from,
      to,
    );
    const records = own.filter((r) => r.date >= from && r.date <= to);
    const days = [...new Set(records.map((r) => r.date))]
      .sort()
      .reverse()
      .map((date) => ({
        date,
        marks: records
          .filter((r) => r.date === date)
          // Имена преподавателей студенту не показываем: только дисциплина и отметка.
          .map((r) => ({ course: r.course || "", status: r.status })),
      }));
    res.json({
      from,
      to,
      absenceDays: summary.absenceDays,
      lastVisit: summary.lastVisit,
      days,
    });
  });
  app.get("/api/student/requirements", onlyStudent, (req, res) => {
    // Кабинету нужны свои сканы под каждым требованием – карточка сотрудника
    // отдаёт их отдельным плоским списком, студенту удобнее по требованиям.
    const attachments = all(
      "SELECT id,kind,fileName,size,uploadedAt FROM attachments WHERE studentId=? ORDER BY uploadedAt",
      req.studentId,
    );
    const requirements = proceduresFor(req.studentId).map((p) => ({
      ...p,
      attachments: attachments
        .filter((a) => a.kind === p.id)
        .map(({ id, fileName, size, uploadedAt }) => ({
          id,
          fileName,
          size,
          uploadedAt,
        })),
    }));
    res.json({ requirements });
  });
  app.put("/api/student/requirements/:kind", onlyStudent, (req, res) => {
    if (
      typeof req.body !== "object" ||
      req.body === null ||
      Array.isArray(req.body)
    )
      throw fail(400, "Некорректные данные");
    const rule = procedureCatalog.find((c) => c.id === req.params.kind);
    if (!rule) throw fail(404, "Требование не найдено");
    const { state, validUntil = "", completedAt = "", note = "" } = req.body;
    const previous = proceduresFor(req.studentId).find(
      (p) => p.id === req.params.kind,
    );
    // Студент не освобождает себя и не подтверждает то, что проверяет сотрудник.
    const allowed =
      rule.closedBy === "student"
        ? ["pending", "submitted", "confirmed"]
        : ["pending", "submitted"];
    if (!allowed.includes(state))
      throw fail(403, "Этот статус ставит учебный офис");
    // Освобождение ставит только сотрудник – студент его не переписывает,
    // кто бы ни закрывал требование.
    if (previous.state === "exempt")
      throw fail(
        403,
        "Учебный офис отметил, что требование не нужно, обратитесь к менеджеру",
      );
    // Подтверждённое сотрудником требование студент откатить не может –
    // иначе он мог бы отменить уже проверенный сотрудником результат.
    // Исключение – истёкший срок действия: документ нужно продлить.
    if (
      rule.closedBy === "staff" &&
      previous.state === "confirmed" &&
      previous.status !== "expired"
    )
      throw fail(
        403,
        "Требование подтверждено учебным офисом, обратитесь к менеджеру",
      );
    if (
      ![validUntil, completedAt].every(validDate) ||
      typeof note !== "string" ||
      note.length > 1000 ||
      (state === "confirmed" && (!completedAt || completedAt > moscowDate()))
    )
      throw fail(400, "Проверьте даты и пояснение");
    if (req.body.version !== (previous.version || 0))
      throw fail(409, "Требование изменено. Откройте страницу заново");
    const data = {
      version: (previous.version || 0) + 1,
      state,
      dueDate: previous.dueDate || "",
      validUntil,
      completedAt,
      note: note.trim(),
      checkedBy: previous.checkedBy || "",
      submittedAt: new Date().toISOString(),
      submittedBy: "student",
      updatedAt: new Date().toISOString(),
    };
    run(
      "INSERT OR REPLACE INTO procedures VALUES(?,?,?)",
      req.studentId,
      req.params.kind,
      JSON.stringify(data),
    );
    audit(
      req.session.user,
      "student.requirement",
      req.studentId + ":" + req.params.kind,
      studentProfile(req.studentId).name + " – " + rule.title,
    );
    res.json({ ok: true, version: data.version });
  });
  app.post(
    "/api/student/attachments/:kind",
    onlyStudent,
    express.raw({ type: () => true, limit: "10mb" }),
    (req, res) => {
      if (!procedureCatalog.some((c) => c.id === req.params.kind))
        throw fail(404, "Требование не найдено");
      if (!Buffer.isBuffer(req.body) || !req.body.length)
        throw fail(400, "Загрузите файл PDF, JPEG или PNG");
      const type = detectType(req.body);
      if (!type) throw fail(400, "Принимаются только PDF, JPEG и PNG");
      const count = get(
        "SELECT COUNT(*) n FROM attachments WHERE studentId=? AND kind=?",
        req.studentId,
        req.params.kind,
      ).n;
      if (count >= 10)
        throw fail(400, "К одному требованию не больше 10 файлов");
      const saved = saveAttachment({
        dir: uploadDir,
        studentId: req.studentId,
        buffer: req.body,
        ext: type.ext,
      });
      const id = "a_" + randomBytes(8).toString("hex");
      const fileName = cleanName(req.headers["x-file-name"]);
      try {
        run(
          "INSERT INTO attachments VALUES(?,?,?,?,?,?,?,?,?,?)",
          id,
          req.studentId,
          req.params.kind,
          fileName,
          saved.storedName,
          type.mime,
          saved.size,
          saved.sha256,
          new Date().toISOString(),
          req.session.user.name,
        );
      } catch (error) {
        // Запись в базу не удалась – файл-сирота на диске не оставляем.
        rmSync(attachmentPath(uploadDir, req.studentId, saved.storedName), {
          force: true,
        });
        throw error;
      }
      audit(
        req.session.user,
        "attachment.add",
        req.studentId + ":" + id,
        attachmentLabel(studentProfile(req.studentId).name, {
          kind: req.params.kind,
          fileName,
        }),
      );
      res.json({ id });
    },
    // express.raw отвечает на слишком большой файл по-английски.
    (err, req, res, next) =>
      next(
        err.type === "entity.too.large" ? fail(413, "Файл больше 10 МБ") : err,
      ),
  );
  // Общий маршрут скачивания: свой скан студенту, чужой – только менеджеру
  // программы и курса или полному доступу; преподавателю сканы не показываются.
  app.get("/api/attachments/:id", (req, res) => {
    const user = req.session?.user;
    if (!user) throw fail(401, "Войдите в свой кабинет");
    const row = get("SELECT * FROM attachments WHERE id=?", req.params.id);
    if (!row) throw fail(404, "Файл не найден");
    const allowed =
      user.role === "student"
        ? user.studentId === row.studentId
        : ["admin", "office"].includes(user.role) &&
          canSeeStudent(user, studentProfile(row.studentId));
    if (!allowed) throw fail(403, "Файл другого студента");
    const file = path.resolve(
      attachmentPath(uploadDir, row.studentId, row.storedName),
    );
    if (!existsSync(file)) throw fail(404, "Файл отсутствует на сервере");
    audit(
      user,
      "attachment.view",
      row.studentId + ":" + row.id,
      attachmentLabel(studentProfile(row.studentId).name, row),
    );
    res.set({
      "Content-Type": row.mime,
      "Cache-Control": "no-store",
      "Content-Disposition":
        "attachment; filename*=UTF-8''" +
        // RFC 5987: encodeURIComponent оставляет ' ( ) * – кодируем и их.
        encodeURIComponent(row.fileName).replace(
          /['()*]/g,
          (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
        ),
    });
    res.sendFile(file);
  });
  app.delete("/api/student/attachments/:id", onlyStudent, (req, res) => {
    const row = get("SELECT * FROM attachments WHERE id=?", req.params.id);
    if (!row || row.studentId !== req.studentId)
      throw fail(404, "Файл не найден");
    const requirement = proceduresFor(req.studentId).find(
      (p) => p.id === row.kind,
    );
    // Подтверждённое или освобождённое требование студент уже не разбирает:
    // файл снимает сотрудник.
    if (requirement.state === "confirmed")
      throw fail(403, "Требование подтверждено, обратитесь к менеджеру");
    if (requirement.state === "exempt")
      throw fail(403, "Требование не нужно, обратитесь к менеджеру");
    rmSync(attachmentPath(uploadDir, row.studentId, row.storedName), {
      force: true,
    });
    run("DELETE FROM attachments WHERE id=?", req.params.id);
    audit(
      req.session.user,
      "attachment.delete",
      req.studentId + ":" + row.id,
      attachmentLabel(studentProfile(req.studentId).name, row),
    );
    res.json({ ok: true });
  });
}
