export const statuses = ["present", "absent"];
export const moscowDate = (date = new Date()) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
export function prioritizeLessons(lessons, now = new Date()) {
  const rank = (l) => {
    const a = new Date(`${l.date}T${l.start}:00+03:00`),
      b = new Date(`${l.date}T${l.end}:00+03:00`);
    return a <= now && b >= now ? 0 : a > now ? 1 : 2;
  };
  return [...lessons].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (rank(a) === 2 ? -1 : 1) *
        `${a.date} ${a.start}`.localeCompare(`${b.date} ${b.start}`),
  );
}
// Считаем только явно отмеченные пропуски. Пустой журнал не означает отсутствие.
export function studentMetrics(records, debts, today = moscowDate()) {
  const completed = records.filter(
    (r) => r.date <= today && statuses.includes(r.status),
  );
  const visits = completed.filter((r) => r.status === "present");
  const lastVisit =
    visits
      .map((r) => r.date)
      .sort()
      .at(-1) || null;
  const absenceDates = [
    ...new Set(
      completed
        .filter(
          (r) => r.status === "absent" && (!lastVisit || r.date > lastVisit),
        )
        .map((r) => r.date),
    ),
  ].sort();
  const days = absenceDates.length;
  const activeDebts = debts.filter((d) => !d.resolved);
  const denominator = completed.length;
  return {
    lastVisit,
    days,
    absences: completed.filter((r) => r.status === "absent").length,
    marked: completed.length,
    attendance: denominator
      ? Math.round((visits.length / denominator) * 100)
      : null,
    debtCount: activeDebts.length,
    absenceAlert: days >= 7,
    attention: days >= 7 && absenceDates.length > 0 && activeDebts.length > 0,
  };
}
