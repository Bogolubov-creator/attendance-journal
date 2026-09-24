// Выдача и сброс личного доступа сотрудникам со страницы «Сотрудники».
import { managers, canSeeStudent } from "./office.js";
import { findPerson } from "./staff-accounts.js";
import { csvCell } from "./csv.js";

export function registerAccess(
  app,
  { staff, roster, audit, fail, studentProfile },
) {
  // Студенты, которых видит сотрудник офиса: по ним решается, чьим преподавателям
  // менеджер вправе выдавать доступ.
  const visibleStudents = (user) =>
    new Set(
      roster.students
        .filter((s) => canSeeStudent(user, studentProfile(s.id)))
        .map((s) => s.id),
    );
  // Полный доступ – любому сотруднику; менеджер – только преподавателям,
  // у которых есть хотя бы один студент его программ и курсов.
  function manageableTeachers(user) {
    if (user.role === "admin") return null;
    const seen = visibleStudents(user);
    return new Set(
      roster.enrollments
        .filter((e) => seen.has(e.studentId))
        .map((e) => e.teacherId),
    );
  }
  function canManage(user, person, allowed = manageableTeachers(user)) {
    if (user.role === "admin") return true;
    return (
      user.role === "office" &&
      person.role === "teacher" &&
      allowed.has(person.id)
    );
  }
  app.get("/api/admin/staff-access", (req, res) => {
    if (req.session.user.role !== "admin")
      throw fail(403, "Доступ сотрудников офиса ведёт полный доступ");
    res.json(
      managers.map((m) => ({
        id: m.id,
        name: m.name,
        role: m.role,
        access: staff.accessState(m.id),
      })),
    );
  });
  app.post("/api/admin/access/:personId", (req, res) => {
    const person = findPerson(req.params.personId, roster);
    if (!person) throw fail(404, "Сотрудник не найден");
    if (!canManage(req.session.user, person))
      throw fail(
        403,
        "Выдать доступ этому сотруднику может только полный доступ",
      );
    const reset = !!staff.byPerson(person.id)?.passwordHash;
    if (reset) staff.resetPassword(person.id);
    const invite = staff.issueInvite(person);
    audit(
      req.session.user,
      reset ? "access.reset" : "access.invite",
      person.id,
      person.name,
    );
    res.json({ ...invite, name: person.name, reset });
  });
  // Кому нужен личный пароль и у кого его ещё нет: сотрудники офиса
  // и преподаватели, у которых есть студенты.
  function withoutPassword() {
    const withStudents = new Set(roster.enrollments.map((e) => e.teacherId));
    return [
      ...managers.map((m) => findPerson(m.id, roster)),
      ...roster.teachers
        .filter((t) => withStudents.has(t.id))
        .map((t) => findPerson(t.id, roster)),
    ].filter((p) => !staff.byPerson(p.id)?.passwordHash);
  }
  const adminOnly = (req) => {
    if (req.session.user.role !== "admin")
      throw fail(403, "Режим входа меняет полный доступ");
  };
  // День X: предпросмотр и включение режима «только личные пароли».
  app.get("/api/admin/personal-only", (req, res) => {
    adminOnly(req);
    res.json({
      enabled: staff.personalOnly(),
      withoutPassword: withoutPassword().length,
    });
  });
  app.post("/api/admin/personal-only", (req, res) => {
    adminOnly(req);
    if (req.body.confirm !== true)
      throw fail(400, "Подтвердите включение режима");
    if (!staff.personalOnly()) {
      staff.enablePersonalOnly(req.session.user.name);
      audit(
        req.session.user,
        "access.mode",
        "access",
        `вход только по личным паролям; без пароля: ${withoutPassword().length}`,
      );
    }
    res.json({ enabled: true });
  });
  // Массовая выгрузка для первой раздачи: преподаватели со студентами и сотрудники
  // офиса без пароля. Каждому – новый код, прежние неиспользованные гаснут.
  app.post("/api/admin/access-export", (req, res) => {
    if (req.session.user.role !== "admin")
      throw fail(403, "Выгрузку кодов делает полный доступ");
    const people = withoutPassword();
    staff.expireInvites();
    const roles = {
      admin: "Полный доступ",
      office: "Менеджер",
      teacher: "Преподаватель",
    };
    const until = (ms) =>
      new Date(ms).toLocaleDateString("ru-RU", { timeZone: "Europe/Moscow" });
    const rows = people.map((p) => {
      const invite = staff.issueInvite(p);
      return [
        p.name,
        roles[p.role],
        invite.login,
        invite.code,
        until(invite.expires),
      ];
    });
    audit(
      req.session.user,
      "access.export",
      "access",
      `кодов приглашения: ${rows.length}`,
    );
    res.set({
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="invite-codes.csv"',
    });
    res.send(
      "\uFEFF" +
        [["ФИО", "Роль", "Логин", "Код приглашения", "Действует до"], ...rows]
          .map((r) => r.map(csvCell).join(";"))
          .join("\r\n"),
    );
  });
  // Для списка преподавателей: состояние доступа и право менеджера на выдачу.
  return function accessFor(user) {
    const allowed = manageableTeachers(user);
    return (teacher) => ({
      access: staff.accessState(teacher.id),
      canManageAccess: canManage(
        user,
        { id: teacher.id, role: "teacher" },
        allowed,
      ),
    });
  };
}
