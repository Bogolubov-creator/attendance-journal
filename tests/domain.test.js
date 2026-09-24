import test from "node:test";
import assert from "node:assert/strict";
import { studentMetrics, studentId } from "../src/domain.js";
const absent = (date) => ({ date, status: "absent" }),
  present = (date) => ({ date, status: "present" });
const seven = Array.from({ length: 7 }, (_, i) =>
  absent(`2026-09-${String(i + 1).padStart(2, "0")}`),
);
const eight = [...seven, absent("2026-09-08")];
test("Тревога: семь учебных дней без тревоги, восемь с тревогой", () => {
  assert.equal(
    studentMetrics([absent("2026-09-01")], [], "2026-09-16").absenceAlert,
    false,
  );
  assert.equal(studentMetrics(seven, [], "2026-09-16").absenceAlert, false);
  assert.equal(studentMetrics(eight, [], "2026-09-16").absenceAlert, true);
});
test("Несколько пар в день считаются один раз", () =>
  assert.equal(
    studentMetrics(Array(8).fill(absent("2026-09-01")), [], "2026-09-16").days,
    1,
  ));
test("Посещение сбрасывает последовательность; явка и пропуск в один день не дают день отсутствия", () => {
  assert.equal(
    studentMetrics([...seven, present("2026-09-07")], [], "2026-09-16").days,
    0,
  );
  assert.equal(
    studentMetrics([...seven, present("2026-09-05")], [], "2026-09-16").days,
    2,
  );
});
test("Пустой журнал не создаёт пропуск и процент", () => {
  const m = studentMetrics([], [], "2026-09-16");
  assert.equal(m.absenceAlert, false);
  assert.equal(m.attendance, null);
});
test("Долги считаются отдельно, закрытый долг исключён", () => {
  assert.equal(
    studentMetrics(eight, [{ resolved: 0 }], "2026-09-16").attention,
    true,
  );
  assert.equal(
    studentMetrics(eight, [{ resolved: 1 }], "2026-09-16").attention,
    false,
  );
});
test("Будущие отметки не влияют на показатели", () =>
  assert.equal(
    studentMetrics([absent("2026-10-01")], [], "2026-09-16").days,
    0,
  ));
test("Идентификатор студента по ФИО не меняется", () => {
  // Та же формула, что в scripts/import_roster.py: «s_» + sha256(ФИО)[:16].
  assert.equal(studentId("Иванов Иван Иванович"), "s_80b2a51a94a72152");
});
