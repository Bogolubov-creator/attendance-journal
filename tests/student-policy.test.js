import test from "node:test";
import assert from "node:assert/strict";
import {
  procedureCatalog,
  studentEditableFields,
  pickStudentFields,
} from "../src/office.js";

test("Каждое требование говорит, кто ставит итог", () => {
  for (const item of procedureCatalog)
    assert.ok(
      ["staff", "student"].includes(item.closedBy),
      item.id + " без closedBy",
    );
  // По умолчанию подтверждает сотрудник, пока владелец не назвал исключения.
  assert.ok(procedureCatalog.every((item) => item.closedBy === "staff"));
});

test("Студенту доступны документные и бытовые поля, учебные – нет", () => {
  assert.deepEqual(studentEditableFields, [
    "citizenship",
    "nameLatin",
    "sendingCountry",
    "arrivalDate",
    "residence",
    "passportUntil",
    "migrationCardUntil",
    "housing",
    "inRussia",
  ]);
  for (const forbidden of [
    "program",
    "year",
    "foreignStatus",
    "enrollmentStatus",
    "programVersion",
    "curator",
  ])
    assert.ok(!studentEditableFields.includes(forbidden), forbidden);
});

test("Чужие поля из запроса студента отбрасываются, а не вызывают ошибку", () => {
  const previous = { program: "Право", year: 3, citizenship: "Сербия" };
  const result = pickStudentFields(
    { program: "Юрист в бизнесе", year: 1, citizenship: "Китай", housing: "" },
    previous,
  );
  assert.equal(result.program, "Право");
  assert.equal(result.year, 3);
  assert.equal(result.citizenship, "Китай");
  assert.equal(result.housing, "");
});
