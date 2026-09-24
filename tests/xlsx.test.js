import test from "node:test";
import assert from "node:assert/strict";
import { readWorkbook } from "../src/xlsx.js";
import { workbook } from "./fixtures/zip.js";

const tooLarge = (e) => e.status === 400 && /50 МБ/.test(e.message);

test("Одна запись больше 50 МБ после распаковки отклоняется с 400", () => {
  assert.throws(() => readWorkbook(workbook({ База: 60 })), tooLarge);
});

test("Записи вместе больше 50 МБ после распаковки отклоняются с 400", () => {
  assert.throws(
    () => readWorkbook(workbook({ База: 30, Второй: 30 })),
    tooLarge,
  );
});

test("Записи, не нужные для чтения листов, не распаковываются", () => {
  const file = workbook({ База: 0 }, [
    { name: "xl/media/image1.png", raw: Buffer.from([0xff, 0xff, 0xff]) },
    { name: "xl/theme/theme1.xml", raw: Buffer.from([0xff, 0xff, 0xff]) },
  ]);
  assert.deepEqual(readWorkbook(file).База, [["ok"]]);
});
