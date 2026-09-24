import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdirSync, existsSync } from "node:fs";

// Открытие базы, схема, разовые миграции и первичное наполнение реестра.
// roster – общий объект реестра из server.js: сюда загружается его копия из базы.
export function openDatabase({ demo, roster }) {
  mkdirSync("data", { recursive: true });
  // Таблицы lessons и marks больше не пополняются: в них исторические отметки прежнего журнала по парам.
  const db = new DatabaseSync(
    process.env.DB_PATH || `data/${demo ? "demo" : "attendance"}.sqlite`,
  );
  db.exec(
    `PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS lessons(id TEXT PRIMARY KEY,teacherId TEXT,data TEXT);CREATE TABLE IF NOT EXISTS marks(lessonId TEXT,studentId TEXT,status TEXT,note TEXT,updatedAt TEXT, PRIMARY KEY(lessonId,studentId)); CREATE TABLE IF NOT EXISTS debts(id TEXT PRIMARY KEY,studentId TEXT,title TEXT,resolved INTEGER DEFAULT 0,createdAt TEXT);CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,actor TEXT,action TEXT,entity TEXT,at TEXT); CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,data TEXT,expires INTEGER);`,
  );
  db.exec(
    "PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS service_state(key TEXT PRIMARY KEY,value TEXT);",
  );
  db.exec(`CREATE TABLE IF NOT EXISTS student_profiles(studentId TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS student_accounts(externalId TEXT PRIMARY KEY, studentId TEXT NOT NULL, linkedAt TEXT NOT NULL, linkedBy TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS procedures(studentId TEXT, kind TEXT, data TEXT NOT NULL, PRIMARY KEY(studentId,kind));
CREATE TABLE IF NOT EXISTS roster_additions(id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS roster_students(id TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS roster_teachers(id TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS roster_enrollments(studentId TEXT NOT NULL, teacherId TEXT NOT NULL, grp TEXT NOT NULL, course TEXT NOT NULL, kind TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS attachments(id TEXT PRIMARY KEY, studentId TEXT NOT NULL, kind TEXT NOT NULL, fileName TEXT NOT NULL, storedName TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, uploadedAt TEXT NOT NULL, uploadedBy TEXT NOT NULL);`);
  const get = (sql, ...a) => db.prepare(sql).get(...a),
    all = (sql, ...a) => db.prepare(sql).all(...a),
    run = (sql, ...a) => db.prepare(sql).run(...a);
  const addEnrollment = (e) =>
    run(
      "INSERT INTO roster_enrollments VALUES(?,?,?,?,?)",
      e.studentId,
      e.teacherId,
      e.group,
      e.course,
      e.kind,
    );
  // Первое наполнение пустой базы: файл импорта и прежние ручные добавления. Дальше файл не читается.
  if (
    !get("SELECT 1 FROM roster_students") &&
    !get("SELECT 1 FROM roster_teachers")
  ) {
    const rosterPath = process.env.ROSTER_PATH || "data/roster.json";
    const file = existsSync(rosterPath)
      ? JSON.parse(readFileSync(rosterPath, "utf8"))
      : { students: [], teachers: [], enrollments: [], quality: {} };
    db.exec("BEGIN IMMEDIATE");
    for (const s of file.students)
      run("INSERT INTO roster_students VALUES(?,?)", s.id, s.name);
    for (const t of file.teachers)
      run("INSERT INTO roster_teachers VALUES(?,?)", t.id, t.name);
    file.enrollments.forEach(addEnrollment);
    for (const row of all("SELECT data FROM roster_additions")) {
      const a = JSON.parse(row.data);
      run("INSERT OR IGNORE INTO roster_students VALUES(?,?)", a.id, a.name);
      for (const l of a.links)
        addEnrollment({
          studentId: a.id,
          teacherId: l.teacherId,
          group: "",
          course: l.course,
          kind: "ручной ввод",
        });
    }
    run(
      "INSERT OR REPLACE INTO service_state VALUES('rosterQuality',?)",
      JSON.stringify(file.quality || {}),
    );
    db.exec("COMMIT");
  }
  roster.students = all("SELECT id,name FROM roster_students ORDER BY rowid");
  roster.teachers = all("SELECT id,name FROM roster_teachers ORDER BY rowid");
  roster.enrollments = all(
    "SELECT studentId,teacherId,grp AS 'group',course,kind FROM roster_enrollments ORDER BY rowid",
  );
  roster.quality = JSON.parse(
    get("SELECT value FROM service_state WHERE key='rosterQuality'")?.value ||
      "{}",
  );
  // Журнал изменений: кто, что и над чем; label – человекочитаемое описание для «Последних изменений».
  if (!all("PRAGMA table_info(audit)").some((c) => c.name === "label"))
    db.exec(
      "ALTER TABLE audit ADD COLUMN role TEXT; ALTER TABLE audit ADD COLUMN label TEXT;",
    );
  return { db, get, all, run, addEnrollment };
}
