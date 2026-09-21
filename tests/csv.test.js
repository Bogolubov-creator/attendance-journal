import test from "node:test";
import assert from "node:assert/strict";
import { csvCell } from "../src/csv.js";
test("CSV: формулы с пробелами и управляющими символами не исполняются", () => {
  for (const prefix of ["", " ", "\t", "\r\n"]) {
    for (const formula of ["=1+1", "+1", "-1", "@SUM(A1)"]) {
      assert.equal(csvCell(prefix + formula), "\"'" + prefix + formula + '"');
    }
  }
  assert.equal(csvCell('Иванов; "А"'), '"Иванов; ""А"""');
  assert.equal(csvCell(null), '""');
});
