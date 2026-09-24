// Выдача и сброс личного доступа сотрудникам со страницы «Сотрудники».
import { managers, canSeeStudent } from "./office.js";
import { findPerson } from "./staff-accounts.js";

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
