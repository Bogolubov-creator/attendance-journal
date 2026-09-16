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

test("Пустое тело person: точный lecturer ID используется для запроса, неоднозначность отклоняется", async () => {
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
  await assert.rejects(
    loadTeacherSchedule(
      async (path) =>
        path.startsWith("search?")
          ? [
              { id: "1", label: "Иванов" },
              { id: "2", label: "Иванов" },
            ]
          : parseRuzResponse(""),
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
