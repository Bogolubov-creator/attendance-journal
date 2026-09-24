import { createHash } from "node:crypto";
// Форматтер и сортировщик создаются один раз: на каждый вызов это заметно дорого.
const moscowFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Moscow",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
export const moscowDate = (date = new Date()) => moscowFormat.format(date);
// То же, что a.localeCompare(b, "ru").
export const ruCompare = new Intl.Collator("ru").compare;
// Идентификатор записи реестра по ФИО: префикс + первые 16 знаков sha256.
// Та же формула в scripts/import_roster.py и scripts/import_profiles.py –
// менять её нельзя, иначе у существующих студентов сменятся id.
export const rosterId = (prefix, name) =>
  prefix + createHash("sha256").update(name).digest("hex").slice(0, 16);
export const studentId = (name) => rosterId("s_", name);
// Считаем только явно отмеченные пропуски. Пустой журнал не означает отсутствие.
// Один проход по отметкам: обзор реестра считает метрики по всем отметкам года.
export function studentMetrics(records, debts, today = moscowDate()) {
  let latest = null,
    visits = 0;
  const absentDates = [];
  for (const r of records) {
    if (!(r.date <= today)) continue;
    if (r.status === "present") {
      visits++;
      if (latest === null || r.date > latest) latest = r.date;
    } else if (r.status === "absent") absentDates.push(r.date);
  }
  const lastVisit = latest || null;
  const days = new Set(
    lastVisit ? absentDates.filter((d) => d > lastVisit) : absentDates,
  ).size;
  const activeDebts = debts.filter((d) => !d.resolved);
  const denominator = visits + absentDates.length;
  return {
    lastVisit,
    days,
    absences: absentDates.length,
    marked: denominator,
    attendance: denominator ? Math.round((visits / denominator) * 100) : null,
    debtCount: activeDebts.length,
    absenceAlert: days > 7,
    attention: days > 7 && activeDebts.length > 0,
  };
}
