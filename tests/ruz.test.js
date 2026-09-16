import test from "node:test";
import assert from "node:assert/strict";
import { parseRuzResponse } from "../src/ruz.js";
test("Перенаправление на ограничение сети не становится пустым расписанием", () => {
  assert.throws(
    () =>
      parseRuzResponse(
        "<html>Страница ВШЭ</html>",
        "https://www.hse.ru/eduland/schedule/?type=person",
      ),
    { code: "RUZ_NETWORK_REQUIRED" },
  );
  assert.throws(
    () =>
      parseRuzResponse(
        "Доступ к&nbsp;РУЗ осуществляется только из внутренней сети НИУ ВШЭ.",
      ),
    { code: "RUZ_NETWORK_REQUIRED" },
  );
});
test("Настоящий пустой JSON и записи расписания принимаются; повреждённые ответы отклоняются", () => {
  assert.deepEqual(parseRuzResponse("[]"), []);
  assert.deepEqual(parseRuzResponse('[{"lessonOid":1}]'), [{ lessonOid: 1 }]);
  for (const text of ["", "<html>Ошибка</html>", "{}"])
    assert.throws(() => parseRuzResponse(text), { status: 502 });
});

test("Пустое тело person: lecturer ID используется для запроса, двойные карточки lecturer объединяются", async () => {
  const { loadTeacherSchedule } = await import("../src/ruz.js");
  const calls = [];
  const fetchData = async (path) => {
    calls.push(path);
    if (path.startsWith("schedule/person/")) return parseRuzResponse("");
    if (path.startsWith("search?"))
      return [{ id: "32718", label: "Аминов Евгений Раульевич" }];
    assert.equal(path, "schedule/lecturer/32718?start=2026.09.09");
    return [];
  };
  assert.deepEqual(
    await loadTeacherSchedule(
      fetchData,
      "Аминов Евгений Раульевич",
      "-27",
      "start=2026.09.09",
    ),
    [],
  );
  assert.equal(calls.length, 3);
  // Две карточки lecturer с одним ФИО: расписания объединяются без дублей.
  const merged = await loadTeacherSchedule(
    async (path) => {
      if (path.startsWith("search?"))
        return [
          { id: "1", label: "Иванов" },
          { id: "2", label: "Иванов" },
        ];
      if (path === "schedule/lecturer/1?d") return [{ lessonOid: 5 }];
      if (path === "schedule/lecturer/2?d")
        return [{ lessonOid: 5 }, { lessonOid: 6 }];
      return parseRuzResponse("");
    },
    "Иванов",
    "-1",
    "d",
  );
  assert.deepEqual(
    merged.map((e) => e.lessonOid),
    [5, 6],
  );
  await assert.rejects(
    loadTeacherSchedule(
      async (path) => (path.startsWith("search?") ? [] : parseRuzResponse("")),
      "Иванов",
      "-1",
      "",
    ),
    { status: 409 },
  );
});
test("Ограничение сети не запускает резервный поиск преподавателя", async () => {
  const { loadTeacherSchedule } = await import("../src/ruz.js");
  let calls = 0;
  await assert.rejects(
    loadTeacherSchedule(
      async () => {
        calls++;
        return parseRuzResponse("", "https://www.hse.ru/eduland/schedule/");
      },
      "Имя",
      "1",
      "",
    ),
    { code: "RUZ_NETWORK_REQUIRED" },
  );
  assert.equal(calls, 1);
});
test("Двойные карточки одного человека в РУЗ: расписания объединяются, пустые карточки пропускаются", async () => {
  const { loadSchedules } = await import("../src/ruz.js");
  const lesson = (lessonOid) => ({
    lessonOid,
    date: "2026.09.10",
    beginLesson: "09:30",
    groupOid: 5,
  });
  const fetchData = async (path) => {
    if (path === "schedule/person/-1?d") return [lesson(1)];
    if (path === "schedule/person/-2?d") return parseRuzResponse("");
    if (path === "schedule/person/-3?d") return [lesson(1), lesson(2)];
    throw Error("Неожиданный запрос " + path);
  };
  const entries = await loadSchedules(
    fetchData,
    "Иванов",
    ["-1", "-2", "-3"],
    "d",
  );
  assert.deepEqual(
    entries.map((e) => e.lessonOid),
    [1, 2],
  );
  // Одна карточка: прежний путь с резервным поиском lecturer.
  const single = [];
  assert.deepEqual(
    await loadSchedules(
      async (path) => {
        single.push(path);
        if (path.startsWith("schedule/person/")) return parseRuzResponse("");
        if (path.startsWith("search?")) return [{ id: "7", label: "Иванов" }];
        return [lesson(9)];
      },
      "Иванов",
      ["-1"],
      "d",
    ),
    [lesson(9)],
  );
  assert.equal(single.length, 3);
  // Все карточки с пустым телом: резервный поиск по первой карточке.
  const calls = [];
  await assert.rejects(
    loadSchedules(
      async (path) => {
        calls.push(path);
        if (path.startsWith("search?")) return [];
        return parseRuzResponse("");
      },
      "Иванов",
      ["-1", "-2"],
      "d",
    ),
    { status: 409 },
  );
  assert.ok(calls.some((p) => p.startsWith("search?")));
});
