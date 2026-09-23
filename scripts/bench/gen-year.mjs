// Наполняет копию базы отметками за учебный год: каждая связка «преподаватель – дисциплина – студент»
// отмечается раз в неделю (день недели по хэшу связки), 150 учебных дней, заканчивая 2026-09-23.
// Запуск: node scripts/bench/gen-year.mjs <копия-базы.sqlite> [factor=1]
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(process.argv[2]);
const factor = Number(process.argv[3] || 1); // сколько раз в неделю
db.exec(`CREATE TABLE IF NOT EXISTS daily_marks(teacherId TEXT,date TEXT,course TEXT,studentId TEXT,status TEXT,updatedAt TEXT,PRIMARY KEY(teacherId,date,course,studentId));
CREATE TABLE IF NOT EXISTS daily_revisions(teacherId TEXT,date TEXT,course TEXT,version INTEGER,PRIMARY KEY(teacherId,date,course));`);
try {
  db.exec(
    "ALTER TABLE audit ADD COLUMN role TEXT; ALTER TABLE audit ADD COLUMN label TEXT;",
  );
} catch {}
const enr = db
  .prepare("SELECT DISTINCT studentId,teacherId,course FROM roster_enrollments")
  .all();
const days = [];
const d = new Date("2026-09-23T12:00:00Z");
while (days.length < 150) {
  const w = d.getUTCDay();
  if (w && w < 6) days.unshift(d.toISOString().slice(0, 10));
  d.setUTCDate(d.getUTCDate() - 1);
}
const h = (s) => {
  let x = 0;
  for (const c of s) x = (x * 31 + c.charCodeAt(0)) >>> 0;
  return x;
};
const ins = db.prepare(
  "INSERT OR REPLACE INTO daily_marks VALUES(?,?,?,?,?,?)",
);
const rev = db.prepare(
  "INSERT OR REPLACE INTO daily_revisions VALUES(?,?,?,1)",
);
const aud = db.prepare(
  "INSERT INTO audit(actor,role,action,entity,label,at) VALUES(?,?,?,?,'',?)",
);
const seen = new Set();
let n = 0;
db.exec("BEGIN");
days.forEach((date, i) => {
  const wd = i % 5;
  for (const e of enr) {
    const k = e.teacherId + e.course + e.studentId;
    let hit = false;
    for (let f = 0; f < factor; f++) if ((h(k) + f) % 5 === wd) hit = true;
    if (!hit) continue;
    const status = h(k + date) % 100 < 15 ? "absent" : "present";
    ins.run(
      e.teacherId,
      date,
      e.course,
      e.studentId,
      status,
      date + "T10:00:00Z",
    );
    n++;
    const rk = e.teacherId + date + e.course;
    if (!seen.has(rk)) {
      seen.add(rk);
      rev.run(e.teacherId, date, e.course);
      aud.run(
        "t",
        "teacher",
        "daily.save",
        e.teacherId + ":" + date + ":" + e.course,
        date + "T10:00:00Z",
      );
    }
  }
});
db.exec("COMMIT");
console.log(
  "enrollments",
  enr.length,
  "days",
  days.length,
  days[0],
  days.at(-1),
  "marks",
  n,
  "saves",
  seen.size,
);
