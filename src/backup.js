import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { backup } from "node:sqlite";
import path from "node:path";

// Ежедневная резервная копия (AUTO_BACKUP, BACKUP_DIR, BACKUP_KEEP) и остановка
// сервера по сигналу: дождаться копии, закрыть базу.
export function startBackups(server, { db, run }) {
  let backupTimer,
    backupRunning = false;
  async function createBackup() {
    if (backupRunning) return;
    backupRunning = true;
    try {
      const dir = process.env.BACKUP_DIR || "data/backups";
      mkdirSync(dir, { recursive: true });
      const target = path.join(
        dir,
        "attendance-" +
          new Date().toISOString().replaceAll(":", "-") +
          ".sqlite",
      );
      await backup(db, target);
      // Имя копии начинается с даты по ISO, поэтому обычная сортировка идёт от старых к новым.
      const kept = Number(process.env.BACKUP_KEEP || 14);
      const copies = readdirSync(dir)
        .filter((name) => /^attendance-.+\.sqlite$/.test(name))
        .sort();
      for (const name of copies.slice(0, -kept))
        rmSync(path.join(dir, name), { force: true });
      run(
        "INSERT OR REPLACE INTO service_state VALUES('backup',?)",
        JSON.stringify({ at: new Date().toISOString(), ok: true }),
      );
    } catch {
      run(
        "INSERT OR REPLACE INTO service_state VALUES('backup',?)",
        JSON.stringify({ at: new Date().toISOString(), ok: false }),
      );
    } finally {
      backupRunning = false;
    }
  }
  if (process.env.AUTO_BACKUP === "true") {
    backupTimer = setInterval(createBackup, 86400000);
    backupTimer.unref();
    createBackup();
  }
  let shuttingDown = false;
  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(backupTimer);
    server.close(async () => {
      while (backupRunning) await new Promise((r) => setTimeout(r, 50));
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 30000).unref();
  }
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
