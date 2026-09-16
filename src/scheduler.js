// Постоянная очередь: ошибки не стирают успешный снимок, рестарт не сбрасывает повторы.
export function retryDelay(failures, ambiguous = false) {
  return ambiguous
    ? 86400000
    : Math.min(21600000, 60000 * 2 ** Math.min(failures - 1, 9));
}
export function createScheduler({
  db,
  teacherIds,
  syncTeacher,
  intervalMs = 21600000,
  now = Date.now,
}) {
  db.exec(
    `CREATE TABLE IF NOT EXISTS sync_jobs(teacherId TEXT PRIMARY KEY,nextRun INTEGER NOT NULL DEFAULT 0,lastAttempt TEXT,lastSuccess TEXT,error TEXT,failures INTEGER NOT NULL DEFAULT 0);`,
  );
  for (const id of teacherIds)
    db.prepare("INSERT OR IGNORE INTO sync_jobs(teacherId) VALUES(?)").run(id);
  let running = false,
    stopped = false,
    timer;
  async function tick() {
    if (running || stopped) return false;
    const job = db
      .prepare(
        "SELECT * FROM sync_jobs WHERE nextRun<=? ORDER BY nextRun,teacherId LIMIT 1",
      )
      .get(now());
    if (!job) return false;
    running = true;
    db.prepare("UPDATE sync_jobs SET lastAttempt=? WHERE teacherId=?").run(
      new Date(now()).toISOString(),
      job.teacherId,
    );
    try {
      await syncTeacher(job.teacherId);
      db.prepare(
        "UPDATE sync_jobs SET nextRun=?,lastSuccess=?,error=NULL,failures=0 WHERE teacherId=?",
      ).run(now() + intervalMs, new Date(now()).toISOString(), job.teacherId);
    } catch (e) {
      const failures = job.failures + 1;
      db.prepare(
        "UPDATE sync_jobs SET nextRun=?,error=?,failures=? WHERE teacherId=?",
      ).run(
        now() + retryDelay(failures, e.status === 409),
        e.status
          ? String(e.message).slice(0, 300)
          : "Ошибка обработки данных РУЗ. Повтор запланирован.",
        failures,
        job.teacherId,
      );
    } finally {
      running = false;
    }
    return true;
  }
  return {
    tick,
    start(delayMs = 2000) {
      if (timer) return;
      stopped = false;
      const loop = async () => {
        await tick();
        if (!stopped) {
          timer = setTimeout(loop, delayMs);
          timer.unref();
        }
      };
      timer = setTimeout(loop, 500);
      timer.unref();
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
      timer = null;
    },
    state() {
      return db
        .prepare(
          "SELECT * FROM sync_jobs ORDER BY failures DESC,lastSuccess,teacherId",
        )
        .all();
    },
    success(id) {
      db.prepare(
        "UPDATE sync_jobs SET nextRun=?,lastSuccess=?,error=NULL,failures=0 WHERE teacherId=?",
      ).run(now() + intervalMs, new Date(now()).toISOString(), id);
    },
  };
}
export function resolveTeacherEmail(entries, teacherName) {
  const emails = new Set();
  for (const entry of entries) {
    const people = [entry, ...(entry.listOfLecturers || [])];
    for (const p of people)
      if (p.lecturer?.trim() === teacherName) {
        const email = String(p.lecturerEmail || "")
          .trim()
          .toLowerCase();
        if (/^[^\s@]+@hse\.ru$/.test(email)) emails.add(email);
      }
  }
  return emails.size === 1 ? [...emails][0] : null;
}
