// Замер журнала: node scripts/bench/bench.mjs <копия-базы.sqlite> [N=20]
// Запускает сервер из репозитория на своём порту с переданной копией базы,
// меряет холодный старт, основные маршруты /api/*, вес статики, останавливает сервер.
// Порт и папка результатов настраиваются переменными окружения BENCH_PORT / BENCH_OUT_DIR.
import { spawn } from "node:child_process";
import { gzipSync, brotliCompressSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { passwordHash } from "../../src/management-auth.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT_DIR = process.env.BENCH_OUT_DIR || join(tmpdir(), "attendance-bench");
const PORT = Number(process.env.BENCH_PORT || 3131);
const dbPath = process.argv[2];
if (!dbPath) {
  console.error(
    "Использование: node scripts/bench/bench.mjs <копия-базы.sqlite> [N=20]",
  );
  process.exit(1);
}
const N = Number(process.argv[3] || 20);
const B = `http://127.0.0.1:${PORT}`;
const PASS = "bench-pass";
mkdirSync(OUT_DIR, { recursive: true });
const uploadDir = join(OUT_DIR, "uploads");
mkdirSync(uploadDir, { recursive: true });

const ro = new DatabaseSync(dbPath, { readOnly: true });
const teacherId = ro
  .prepare(
    "SELECT teacherId, count(*) c FROM roster_enrollments GROUP BY teacherId ORDER BY c DESC LIMIT 1",
  )
  .get().teacherId;
const course = ro
  .prepare(
    "SELECT course, count(*) c FROM roster_enrollments WHERE teacherId=? GROUP BY course ORDER BY c DESC LIMIT 1",
  )
  .get(teacherId).course;
const studentId = ro
  .prepare(
    "SELECT studentId, count(*) c FROM roster_enrollments GROUP BY studentId ORDER BY c DESC LIMIT 1",
  )
  .get().studentId;
const marks = (() => {
  try {
    return ro.prepare("SELECT count(*) n FROM daily_marks").get().n;
  } catch {
    return 0;
  }
})();
ro.close();

const t0 = performance.now();
const srv = spawn(process.execPath, ["src/server.js"], {
  cwd: ROOT,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    PORT: String(PORT),
    DEMO_MODE: "true",
    DB_PATH: dbPath,
    UPLOAD_DIR: uploadDir,
    AUTO_BACKUP: "false",
    MANAGEMENT_PASSWORD_HASH: passwordHash(PASS),
  },
});
srv.stderr.on("data", (d) => process.stderr.write(d));
const stop = () => {
  try {
    srv.kill("SIGTERM");
  } catch {}
};
process.on("exit", stop);

let ready = false;
for (let i = 0; i < 400 && !ready; i++) {
  try {
    ready = (await fetch(B + "/healthz")).ok;
  } catch {
    await new Promise((r) => setTimeout(r, 25));
  }
}
const cold = performance.now() - t0;

async function login(body) {
  const r = await fetch(B + "/api/demo-login", {
    method: "POST",
    headers: { "content-type": "application/json", origin: B },
    body: JSON.stringify({ ...body, password: PASS }),
  });
  if (!r.ok) throw Error("login " + r.status + " " + (await r.text()));
  return r.headers.get("set-cookie").split(";")[0];
}
const admin = await login({ role: "admin" });
const teacher = await login({ role: "teacher", teacherId });
const student = await login({ role: "student", studentId });

const q = (p) => (
  p.sort((a, b) => a - b),
  { med: p[Math.floor(p.length / 2)], p95: p[Math.ceil(p.length * 0.95) - 1] }
);
async function measure(name, url, cookie, opts = {}) {
  const t = [];
  let bytes = 0,
    status = 0;
  for (let i = 0; i < N; i++) {
    const s = performance.now();
    const r = await fetch(B + url, {
      ...opts,
      headers: { cookie, origin: B, ...(opts.headers || {}) },
    });
    const buf = Buffer.from(await r.arrayBuffer());
    bytes = buf.length;
    status = r.status;
    t.push(performance.now() - s);
    if (opts.after) await opts.after(buf);
  }
  const { med, p95 } = q(t);
  return {
    name,
    status,
    med: +med.toFixed(1),
    p95: +p95.toFixed(1),
    kb: +(bytes / 1024).toFixed(1),
  };
}

const rows = [];
const from = "2026-09-01",
  to = "2026-09-23";
rows.push(await measure("GET /api/session", "/api/session", admin));
rows.push(
  await measure("GET /api/admin/overview", "/api/admin/overview", admin),
);
rows.push(
  await measure(
    "GET /api/admin/students/:id",
    "/api/admin/students/" + encodeURIComponent(studentId),
    admin,
  ),
);
rows.push(
  await measure("GET /api/admin/teachers", "/api/admin/teachers", admin),
);
rows.push(await measure("GET /api/admin/export", "/api/admin/export", admin));
rows.push(
  await measure(
    "GET /api/daily/overview (сентябрь)",
    `/api/daily/overview?from=${from}&to=${to}`,
    admin,
  ),
);
rows.push(
  await measure(
    "GET /api/daily/export (сентябрь)",
    `/api/daily/export?from=${from}&to=${to}`,
    admin,
  ),
);
rows.push(
  await measure(
    "GET /api/daily (преподаватель)",
    `/api/daily?date=${to}&course=${encodeURIComponent(course)}`,
    teacher,
  ),
);
// PUT: сохранить тот же набор отметок; версия берётся заново.
{
  const t = [];
  for (let i = 0; i < N; i++) {
    const g = await (
      await fetch(
        B + `/api/daily?date=${to}&course=${encodeURIComponent(course)}`,
        { headers: { cookie: teacher } },
      )
    ).json();
    const body = {
      date: to,
      course,
      version: g.version,
      marks: g.students.map((s, k) => ({
        studentId: s.id,
        status: (i + k) % 7 ? "present" : "absent",
      })),
    };
    const s = performance.now();
    const r = await fetch(B + "/api/daily", {
      method: "PUT",
      headers: {
        cookie: teacher,
        origin: B,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    await r.arrayBuffer();
    t.push(performance.now() - s);
    if (!r.ok) throw Error("PUT " + r.status);
  }
  const { med, p95 } = q(t);
  rows.push({
    name: "PUT /api/daily (сохранение)",
    status: 200,
    med: +med.toFixed(1),
    p95: +p95.toFixed(1),
    kb: 0,
  });
}
rows.push(
  await measure(
    "GET /api/student/attendance (сентябрь)",
    `/api/student/attendance?from=${from}&to=${to}`,
    student,
  ),
);
rows.push(
  await measure(
    "GET /api/student/requirements",
    "/api/student/requirements",
    student,
  ),
);

// Блокировка цикла событий: /healthz, пока параллельно идут 5 обзоров.
const hz = [];
const bg = Array.from({ length: 5 }, () =>
  fetch(B + "/api/admin/overview", { headers: { cookie: admin } }).then((r) =>
    r.arrayBuffer(),
  ),
);
for (let i = 0; i < 5; i++) {
  const s = performance.now();
  await (await fetch(B + "/healthz")).arrayBuffer();
  hz.push(performance.now() - s);
}
await Promise.all(bg);

// Статика
const stat = [];
for (const p of [
  "/",
  "/app.js",
  "/style.css",
  "/daily.js",
  "/registry.js",
  "/student.js",
]) {
  const r = await fetch(B + p, { headers: { "accept-encoding": "gzip, br" } });
  const buf = Buffer.from(await r.arrayBuffer());
  stat.push({
    path: p,
    kb: +(buf.length / 1024).toFixed(1),
    gzip: +(gzipSync(buf).length / 1024).toFixed(1),
    br: +(brotliCompressSync(buf).length / 1024).toFixed(1),
    enc: r.headers.get("content-encoding") || "нет",
    cc: r.headers.get("cache-control"),
    etag: !!r.headers.get("etag"),
  });
}
const ov = await (
  await fetch(B + "/api/admin/overview", { headers: { cookie: admin } })
).arrayBuffer();
const result = {
  db: basename(dbPath),
  marks,
  coldStartMs: +cold.toFixed(0),
  N,
  rows,
  healthzUnderLoadMs: hz.map((x) => +x.toFixed(0)),
  overviewGzipKb: +(gzipSync(Buffer.from(ov)).length / 1024).toFixed(1),
  static: stat,
};

const outFile = join(
  OUT_DIR,
  `result-${basename(dbPath).replace(/\.sqlite$/, "")}.json`,
);
writeFileSync(outFile, JSON.stringify(result, null, 1));

console.log(
  `база ${result.db}, отметок ${result.marks}, холодный старт ${result.coldStartMs} мс, N=${result.N}`,
);
for (const r of result.rows)
  console.log(
    "  ",
    r.name,
    "медиана",
    r.med,
    "мс, p95",
    r.p95,
    "мс,",
    r.kb,
    "КБ",
  );
console.log(
  "  healthz под 5 обзорами:",
  result.healthzUnderLoadMs.join(", "),
  "мс; обзор в gzip",
  result.overviewGzipKb,
  "КБ",
);
console.log("результат записан в", outFile);

stop();
await new Promise((r) => srv.on("exit", r));
