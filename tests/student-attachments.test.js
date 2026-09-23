import { passwordHash } from "../src/management-auth.js";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { get as httpGet } from "node:http";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { detectType } from "../src/attachments.js";

test("Тип файла определяется по сигнатуре, а не по имени", () => {
  assert.equal(detectType(Buffer.from("%PDF-1.7\n...")).ext, "pdf");
  assert.equal(
    detectType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])).ext,
    "jpg",
  );
  assert.equal(
    detectType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      .ext,
    "png",
  );
  assert.equal(detectType(Buffer.from("MZ исполняемый")), null);
  assert.equal(detectType(Buffer.alloc(0)), null);
});

const origin = "http://127.0.0.1:3115";
const temp = mkdtempSync(join(tmpdir(), "attendance-attachments-"));
const dbPath = join(temp, "db.sqlite");
const uploadDir = join(temp, "uploads");
const call = (path, options = {}) =>
  fetch(origin + path, {
    method: options.method || "GET",
    headers: {
      origin,
      "content-type": "application/json",
      ...(options.cookie ? { cookie: options.cookie } : {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
const login = async (role, personId) => {
  const r = await call("/api/select-login", {
    method: "POST",
    body: { role, personId, password: "test-management-password" },
  });
  assert.equal(r.status, 200, await r.clone().text());
  return r.headers.get("set-cookie").split(";")[0];
};
const demoLogin = async (studentId) => {
  const r = await call("/api/demo-login", {
    method: "POST",
    body: {
      role: "student",
      studentId,
      password: "test-management-password",
    },
  });
  assert.equal(r.status, 200, await r.clone().text());
  return r.headers.get("set-cookie").split(";")[0];
};
// Читаем таблицу attachments напрямую – список вложений API не отдаёт.
function withDb(fn) {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout=5000;");
  try {
    return fn(db);
  } finally {
    db.close();
  }
}
const attachmentRow = (id) =>
  withDb((db) => db.prepare("SELECT * FROM attachments WHERE id=?").get(id));
const attachmentCount = (studentId, kind) =>
  withDb((db) =>
    db
      .prepare(
        "SELECT COUNT(*) n FROM attachments WHERE studentId=? AND kind=?",
      )
      .get(studentId, kind),
  ).n;
const attachmentIdsFor = (studentId) =>
  withDb((db) =>
    db
      .prepare("SELECT id FROM attachments WHERE studentId=?")
      .all(studentId)
      .map((r) => r.id),
  );

test("Сканы: загрузка, скачивание, удаление", async (t) => {
  const child = spawn(process.execPath, ["src/server.js"], {
    env: {
      ...process.env,
      ROSTER_PATH: "tests/fixtures/roster.json",
      MANAGEMENT_PASSWORD_HASH: passwordHash("test-management-password"),
      DEMO_MODE: "true",
      AUTO_BACKUP: "false",
      DB_PATH: dbPath,
      UPLOAD_DIR: uploadDir,
      PORT: "3115",
      APP_ORIGIN: origin,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    child.stdout.once("data", resolve);
    child.once("exit", (c) => reject(Error("server exit " + c)));
  });
  try {
    const admin = await login("admin", "gadzhieva");
    const foreignManager = await login("office", "smirnova");
    const teacherCookie = await login("teacher", "t_test_1");
    const studentId = "s_test_1";
    const otherStudentId = "s_test_2";
    const cookie = await demoLogin(studentId);
    let id, secondId;

    await t.test(
      "Учётная запись привязана к студенту (нужно для задачи 8)",
      async () => {
        const r = await call("/api/admin/students/" + studentId + "/account", {
          method: "PUT",
          cookie: admin,
          body: { externalId: "hse-777" },
        });
        assert.equal(r.status, 200, await r.clone().text());
      },
    );

    await t.test("Студент прикладывает скан", async () => {
      const r = await fetch(origin + "/api/student/attachments/registration", {
        method: "POST",
        headers: {
          origin,
          cookie,
          "content-type": "application/pdf",
          "x-file-name": encodeURIComponent("Справка.pdf"),
        },
        body: Buffer.from("%PDF-1.7 справка"),
      });
      assert.equal(r.status, 200, await r.clone().text());
      id = (await r.json()).id;
    });

    await t.test("Имя файла с путём не создаёт файл вне папки", async () => {
      const r = await fetch(origin + "/api/student/attachments/registration", {
        method: "POST",
        headers: {
          origin,
          cookie,
          "content-type": "application/pdf",
          "x-file-name": encodeURIComponent("../../побег.pdf"),
        },
        body: Buffer.from("%PDF-1.7 второй"),
      });
      assert.equal(r.status, 200, await r.clone().text());
      secondId = (await r.json()).id;
      const files = readdirSync(uploadDir);
      assert.deepEqual(files, [studentId]);
    });

    await t.test("Исполняемый файл под видом pdf отклоняется", async () => {
      const r = await fetch(origin + "/api/student/attachments/registration", {
        method: "POST",
        headers: { origin, cookie, "content-type": "application/pdf" },
        body: Buffer.from("MZ исполняемый"),
      });
      assert.equal(r.status, 400);
    });

    await t.test(
      "Требование, которого нет в каталоге, отклоняется",
      async () => {
        const r = await fetch(origin + "/api/student/attachments/фантом", {
          method: "POST",
          headers: { origin, cookie, "content-type": "application/pdf" },
          body: Buffer.from("%PDF-1.7"),
        });
        assert.equal(r.status, 404);
      },
    );

    await t.test(
      "Файл больше предела отклоняется и не остаётся на диске",
      async () => {
        const beforeFiles = readdirSync(join(uploadDir, studentId)).length;
        const beforeRows = attachmentCount(studentId, "registration");
        const r = await fetch(
          origin + "/api/student/attachments/registration",
          {
            method: "POST",
            headers: { origin, cookie, "content-type": "application/pdf" },
            body: Buffer.concat([
              Buffer.from("%PDF-1.7"),
              Buffer.alloc(11 * 1024 * 1024),
            ]),
          },
        );
        assert.equal(r.status, 413);
        // Сообщение показывается студенту как есть – по-русски, с пределом.
        assert.equal((await r.json()).error, "Файл больше 10 МБ");
        assert.equal(
          readdirSync(join(uploadDir, studentId)).length,
          beforeFiles,
        );
        assert.equal(attachmentCount(studentId, "registration"), beforeRows);
      },
    );

    await t.test(
      "Имя с управляющими символами, длиной 300 и эмодзи не ломает загрузку и выдачу",
      async () => {
        const weirdName =
          "\u0000\u0007отчёт" +
          "𝑥".repeat(60) +
          "🎉".repeat(30) +
          "a".repeat(300);
        const r = await fetch(origin + "/api/student/attachments/insurance", {
          method: "POST",
          headers: {
            origin,
            cookie,
            "content-type": "application/pdf",
            "x-file-name": encodeURIComponent(weirdName),
          },
          body: Buffer.from("%PDF-1.7 странное имя"),
        });
        assert.equal(r.status, 200, await r.clone().text());
        const weirdId = (await r.json()).id;
        const row = attachmentRow(weirdId);
        // Имя на диске – журнал (шестнадцатеричные символы + расширение), не присланное студентом.
        assert.match(row.storedName, /^[0-9a-f]{32}\.pdf$/);
        // Управляющие символы вычищены из показываемого имени, не только из имени на диске.
        assert.ok(!/[\u0000-\u001f]/.test(row.fileName));
        const dl = await fetch(origin + "/api/attachments/" + weirdId, {
          headers: { origin, cookie },
        });
        assert.equal(dl.status, 200);
        assert.ok(dl.headers.get("content-disposition"));
      },
    );

    await t.test(
      "Эмодзи на границе обрезки не оставляет одинокий суррогат при скачивании",
      async () => {
        // slice(0, 200) резал бы по UTF-16 code unit и разрывал бы суррогатную
        // пару эмодзи ровно на границе – тогда encodeURIComponent при скачивании
        // бросал бы URIError. Имя подобрано так, чтобы эмодзи попало на границу 200.
        const boundaryName = "a".repeat(199) + "🎉.pdf";
        const r = await fetch(origin + "/api/student/attachments/insurance", {
          method: "POST",
          headers: {
            origin,
            cookie,
            "content-type": "application/pdf",
            "x-file-name": encodeURIComponent(boundaryName),
          },
          body: Buffer.from("%PDF-1.7 граница обрезки имени"),
        });
        assert.equal(r.status, 200, await r.clone().text());
        const boundaryId = (await r.json()).id;
        const dl = await fetch(origin + "/api/attachments/" + boundaryId, {
          headers: { origin, cookie },
        });
        assert.equal(dl.status, 200, await dl.clone().text());
        assert.ok(dl.headers.get("content-disposition"));
      },
    );

    await t.test(
      "Скобки, апостроф и звёздочка в имени кодируются по RFC 5987",
      async () => {
        const r = await fetch(origin + "/api/student/attachments/insurance", {
          method: "POST",
          headers: {
            origin,
            cookie,
            "content-type": "application/pdf",
            "x-file-name": encodeURIComponent("скан (копия) O'Neil*.pdf"),
          },
          body: Buffer.from("%PDF-1.7 спецсимволы"),
        });
        assert.equal(r.status, 200, await r.clone().text());
        const dl = await fetch(
          origin + "/api/attachments/" + (await r.json()).id,
          {
            headers: { origin, cookie },
          },
        );
        assert.equal(dl.status, 200);
        const value = dl.headers
          .get("content-disposition")
          .split("filename*=UTF-8''")[1];
        assert.doesNotMatch(value, /['()*]/);
        assert.match(value, /%28/);
        assert.match(value, /%29/);
        assert.match(value, /%27/);
        assert.match(value, /%2A/);
      },
    );

    await t.test("Битое кодирование имени не роняет сервер", async () => {
      const r = await fetch(origin + "/api/student/attachments/insurance", {
        method: "POST",
        headers: {
          origin,
          cookie,
          "content-type": "application/pdf",
          "x-file-name": "%E0%A4%A",
        },
        body: Buffer.from("%PDF-1.7 битое имя"),
      });
      assert.ok([200, 400].includes(r.status));
      if (r.status === 200) {
        const row = attachmentRow((await r.json()).id);
        assert.equal(row.fileName, "файл");
      }
    });

    await t.test(
      "Список требований показывает только свои сканы под нужным требованием",
      async () => {
        const mine = await (
          await call("/api/student/requirements", { cookie })
        ).json();
        const registration = mine.requirements.find(
          (r) => r.id === "registration",
        );
        assert.deepEqual(
          registration.attachments.map((a) => a.id).sort(),
          [id, secondId].sort(),
        );
        for (const a of registration.attachments)
          assert.deepEqual(Object.keys(a).sort(), [
            "fileName",
            "id",
            "size",
            "uploadedAt",
          ]);
        // «visa» ещё не тронуто загрузками к этому месту сценария.
        const visa = mine.requirements.find((r) => r.id === "visa");
        assert.equal(visa.attachments.length, 0);
        const otherCookie = await demoLogin(otherStudentId);
        const theirs = await (
          await call("/api/student/requirements", { cookie: otherCookie })
        ).json();
        assert.equal(
          theirs.requirements.find((r) => r.id === "registration").attachments
            .length,
          0,
        );
      },
    );

    await t.test("Свой файл выдаётся вложением", async () => {
      const r = await fetch(origin + "/api/attachments/" + id, {
        headers: { origin, cookie },
      });
      assert.equal(r.status, 200);
      assert.match(r.headers.get("content-disposition"), /attachment/);
      assert.equal(r.headers.get("content-type"), "application/pdf");
      assert.equal(r.headers.get("cache-control"), "no-store");
      assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    });

    await t.test(
      "Статика – no-cache с ETag и 304, API и скан – no-store, заголовки безопасности прежние",
      async () => {
        // Заголовки безопасности до правки (задача 14) – эталон для сравнения.
        const security = {
          "x-content-type-options": "nosniff",
          "referrer-policy": "same-origin",
          "content-security-policy":
            "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        };
        for (const path of [
          "/",
          "/student.html",
          "/app.js",
          "/style.css",
          "/assets/hse-logo.svg",
        ]) {
          const r = await fetch(origin + path, { headers: { origin } });
          assert.equal(r.status, 200, path);
          await r.arrayBuffer();
          assert.equal(r.headers.get("cache-control"), "no-cache", path);
          const etag = r.headers.get("etag");
          assert.ok(etag, path + " без ETag");
          for (const [name, value] of Object.entries(security))
            assert.equal(r.headers.get(name), value, path + " " + name);
          // fetch сам добавляет Cache-Control: no-cache к условному запросу,
          // поэтому повторный запрос – как у браузера, через node:http.
          const again = await new Promise((resolve, reject) =>
            httpGet(
              origin + path,
              { headers: { origin, "if-none-match": etag } },
              (res) => {
                let size = 0;
                res.on("data", (chunk) => (size += chunk.length));
                res.on("end", () => resolve({ status: res.statusCode, size }));
              },
            ).on("error", reject),
          );
          assert.equal(again.status, 304, path);
          assert.equal(again.size, 0, path);
        }
        for (const path of ["/api/session", "/api/student/requirements"]) {
          const r = await fetch(origin + path, { headers: { origin, cookie } });
          await r.arrayBuffer();
          assert.equal(r.headers.get("cache-control"), "no-store", path);
          for (const [name, value] of Object.entries(security))
            assert.equal(r.headers.get(name), value, path + " " + name);
        }
        const health = await fetch(origin + "/healthz", {
          headers: { origin },
        });
        await health.arrayBuffer();
        assert.equal(health.headers.get("cache-control"), "no-store");
        const scan = await fetch(origin + "/api/attachments/" + id, {
          headers: { origin, cookie },
        });
        await scan.arrayBuffer();
        assert.equal(scan.headers.get("cache-control"), "no-store");
      },
    );

    await t.test("Неавторизованный запрос отклоняется", async () => {
      const r = await fetch(origin + "/api/attachments/" + id, {
        headers: { origin },
      });
      assert.equal(r.status, 401);
    });

    await t.test("Чужой файл не выдаётся", async () => {
      const otherCookie = await demoLogin(otherStudentId);
      const r = await fetch(origin + "/api/attachments/" + id, {
        headers: { origin, cookie: otherCookie },
      });
      assert.equal(r.status, 403);
    });

    await t.test(
      "Менеджер своей программы файл открывает, чужой – нет",
      async () => {
        assert.equal(
          (
            await fetch(origin + "/api/attachments/" + id, {
              headers: { origin, cookie: admin },
            })
          ).status,
          200,
        );
        assert.equal(
          (
            await fetch(origin + "/api/attachments/" + id, {
              headers: { origin, cookie: foreignManager },
            })
          ).status,
          403,
        );
      },
    );

    await t.test("Преподаватель не открывает сканы", async () => {
      const r = await fetch(origin + "/api/attachments/" + id, {
        headers: { origin, cookie: teacherCookie },
      });
      assert.equal(r.status, 403);
    });

    await t.test("Пропавший на диске файл даёт 404, а не 500", async () => {
      const upload = await fetch(origin + "/api/student/attachments/medical", {
        method: "POST",
        headers: { origin, cookie, "content-type": "application/pdf" },
        body: Buffer.from("%PDF-1.7 будет удалён вручную"),
      });
      assert.equal(upload.status, 200);
      const ghostId = (await upload.json()).id;
      const row = attachmentRow(ghostId);
      rmSync(join(uploadDir, studentId, row.storedName), { force: true });
      const r = await fetch(origin + "/api/attachments/" + ghostId, {
        headers: { origin, cookie },
      });
      assert.equal(r.status, 404);
      await call("/api/student/attachments/" + ghostId, {
        method: "DELETE",
        cookie,
      });
    });

    await t.test("Открытие файла попадает в журнал изменений", async () => {
      const overview = await (
        await call("/api/admin/overview?from=2026-09-01&to=2026-09-30", {
          cookie: admin,
        })
      ).json();
      assert.ok(overview.audit.some((row) => row.action === "attachment.add"));
      assert.ok(overview.audit.some((row) => row.action === "attachment.view"));
    });

    await t.test("Не более 10 файлов на одно требование", async () => {
      for (let i = 0; i < 10; i++) {
        const r = await fetch(
          origin + "/api/student/attachments/fingerprints",
          {
            method: "POST",
            headers: { origin, cookie, "content-type": "application/pdf" },
            body: Buffer.from("%PDF-1.7 " + i),
          },
        );
        assert.equal(r.status, 200, await r.clone().text());
      }
      const overflow = await fetch(
        origin + "/api/student/attachments/fingerprints",
        {
          method: "POST",
          headers: { origin, cookie, "content-type": "application/pdf" },
          body: Buffer.from("%PDF-1.7 одиннадцатый"),
        },
      );
      assert.equal(overflow.status, 400);
    });

    await t.test(
      "Студент удаляет свой файл, пока требование не подтверждено",
      async () => {
        assert.equal(
          (
            await call("/api/student/attachments/" + id, {
              method: "DELETE",
              cookie,
            })
          ).status,
          200,
        );
      },
    );

    await t.test("Чужой файл студент удалить не может", async () => {
      const otherCookie = await demoLogin(otherStudentId);
      const r = await call("/api/student/attachments/" + secondId, {
        method: "DELETE",
        cookie: otherCookie,
      });
      assert.equal(r.status, 404);
    });

    await t.test("После подтверждения студент файл не удаляет", async () => {
      // Читаем текущую версию требования с карточки сотрудника – на свежем сервере она не обязана быть 1.
      const card = await (
        await call("/api/admin/students/" + studentId, { cookie: admin })
      ).json();
      const registration = card.procedures.find((p) => p.id === "registration");
      const confirm = await call(
        "/api/admin/students/" + studentId + "/procedures/registration",
        {
          method: "PUT",
          cookie: admin,
          body: {
            state: "confirmed",
            completedAt: "2026-09-01",
            version: registration.version || 0,
          },
        },
      );
      assert.equal(confirm.status, 200, await confirm.clone().text());
      const r = await call("/api/student/attachments/" + secondId, {
        method: "DELETE",
        cookie,
      });
      assert.equal(r.status, 403);
    });

    await t.test(
      "Сотрудник удаляет скан даже после подтверждения требования, файл пропадает с диска",
      async () => {
        const row = attachmentRow(secondId);
        const filePath = join(uploadDir, studentId, row.storedName);
        assert.ok(
          readdirSync(join(uploadDir, studentId)).includes(row.storedName),
        );
        const r = await call("/api/admin/attachments/" + secondId, {
          method: "DELETE",
          cookie: admin,
        });
        assert.equal(r.status, 200, await r.clone().text());
        assert.ok(
          !readdirSync(join(uploadDir, studentId)).includes(row.storedName),
        );
        assert.equal(attachmentRow(secondId), undefined);
        const overview = await (
          await call("/api/admin/overview?from=2026-09-01&to=2026-09-30", {
            cookie: admin,
          })
        ).json();
        assert.ok(
          overview.audit.some((row) => row.action === "attachment.delete"),
        );
      },
    );

    await t.test(
      "Сотрудническое удаление недоступно преподавателю и студенту",
      async () => {
        const upload = await fetch(origin + "/api/student/attachments/visa", {
          method: "POST",
          headers: { origin, cookie, "content-type": "application/pdf" },
          body: Buffer.from("%PDF-1.7 для проверки прав"),
        });
        const spareId = (await upload.json()).id;
        assert.equal(
          (
            await call("/api/admin/attachments/" + spareId, {
              method: "DELETE",
              cookie: teacherCookie,
            })
          ).status,
          403,
        );
        assert.equal(
          (
            await call("/api/admin/attachments/" + spareId, {
              method: "DELETE",
              cookie,
            })
          ).status,
          403,
        );
      },
    );

    await t.test(
      "Освобождённое требование студент не переписывает и сканы не удаляет",
      async () => {
        const card = await (
          await call("/api/admin/students/" + studentId, { cookie: admin })
        ).json();
        const insurance = card.procedures.find((p) => p.id === "insurance");
        const exempt = await call(
          "/api/admin/students/" + studentId + "/procedures/insurance",
          {
            method: "PUT",
            cookie: admin,
            body: {
              state: "exempt",
              note: "Полис не нужен",
              version: insurance.version || 0,
            },
          },
        );
        assert.equal(exempt.status, 200, await exempt.clone().text());
        const { version } = await exempt.json();
        const put = await call("/api/student/requirements/insurance", {
          method: "PUT",
          cookie,
          body: { state: "submitted", note: "Всё же полис", version },
        });
        assert.equal(put.status, 403);
        const scan = withDb((db) =>
          db
            .prepare(
              "SELECT id FROM attachments WHERE studentId=? AND kind='insurance'",
            )
            .get(studentId),
        );
        const del = await call("/api/student/attachments/" + scan.id, {
          method: "DELETE",
          cookie,
        });
        assert.equal(del.status, 403);
        assert.ok(attachmentRow(scan.id));
      },
    );

    await t.test(
      "Добавление и удаление скана записаны в журнал с ролью student и понятной подписью",
      async () => {
        const rows = withDb((db) =>
          db
            .prepare(
              "SELECT action,role,label FROM audit WHERE action IN ('attachment.add','attachment.delete') AND role='student'",
            )
            .all(),
        );
        assert.ok(rows.some((r) => r.action === "attachment.add"));
        assert.ok(rows.some((r) => r.action === "attachment.delete"));
        const add = rows.find((r) => r.action === "attachment.add");
        assert.match(add.label, /Студент Первый/);
        assert.doesNotMatch(add.label, /a_[0-9a-f]{16}/);
      },
    );

    await t.test("Карточка студента показывает сканы и привязку", async () => {
      const card = await (
        await call("/api/admin/students/" + studentId, { cookie: admin })
      ).json();
      const expectedIds = attachmentIdsFor(studentId).sort();
      assert.deepEqual(card.attachments.map((a) => a.id).sort(), expectedIds);
      for (const a of card.attachments) {
        assert.deepEqual(Object.keys(a).sort(), [
          "fileName",
          "id",
          "kind",
          "size",
          "uploadedAt",
          "uploadedBy",
        ]);
      }
      assert.equal(card.account.externalId, "hse-777");
      assert.ok(card.account.linkedAt);
      assert.ok(card.account.linkedBy);
    });

    await t.test(
      "Менеджер, не видящий студента, получает 403 на карточке",
      async () => {
        const r = await call("/api/admin/students/" + studentId, {
          cookie: foreignManager,
        });
        assert.equal(r.status, 403);
      },
    );

    await t.test(
      "Удаление студента со связью или сканами отклоняется; повторное добавление того же ФИО не видит прежних сканов и связи",
      async () => {
        const name = "Студент Удаляемый";
        const addBody = {
          name,
          links: [{ teacherId: "t_test_1", course: "Право" }],
        };
        const added = await call("/api/admin/students", {
          method: "POST",
          cookie: admin,
          body: addBody,
        });
        assert.equal(added.status, 200, await added.clone().text());
        const goneId = (await added.json()).id;
        const link = await call("/api/admin/students/" + goneId + "/account", {
          method: "PUT",
          cookie: admin,
          body: { externalId: "hse-gone" },
        });
        assert.equal(link.status, 200, await link.clone().text());
        // Провайдера OIDC в тестах нет – сессию кладём в базу напрямую,
        // как это делает tests/student-account.test.js.
        const rawToken = "test-oidc-gone-" + Math.random().toString(36);
        withDb((db) =>
          db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(
            createHash("sha256").update(rawToken).digest("hex"),
            JSON.stringify({
              user: {
                id: goneId,
                name,
                role: "student",
                studentId: goneId,
                source: "oidc",
                subject: "hse-gone",
              },
            }),
            Date.now() + 8 * 3600000,
          ),
        );
        const oidcCookie = "journal=" + rawToken;
        const upload = await fetch(
          origin + "/api/student/attachments/registration",
          {
            method: "POST",
            headers: {
              origin,
              cookie: oidcCookie,
              "content-type": "application/pdf",
              "x-file-name": encodeURIComponent("Паспорт.pdf"),
            },
            body: Buffer.from("%PDF-1.7 паспорт"),
          },
        );
        assert.equal(upload.status, 200, await upload.clone().text());
        const scanId = (await upload.json()).id;
        const storedName = attachmentRow(scanId).storedName;

        const refused = await call("/api/admin/students/" + goneId, {
          method: "DELETE",
          cookie: admin,
        });
        assert.equal(refused.status, 409);
        assert.match((await refused.json()).error, /учётную запись/);
        assert.ok(attachmentRow(scanId), "строка скана на месте");
        assert.ok(
          readdirSync(join(uploadDir, goneId)).includes(storedName),
          "файл скана на месте",
        );
        assert.equal(
          (await call("/api/student/profile", { cookie: oidcCookie })).status,
          200,
          "связь не тронута",
        );

        const unlink = await call(
          "/api/admin/students/" + goneId + "/account",
          { method: "DELETE", cookie: admin },
        );
        assert.equal(unlink.status, 200);
        const stillScans = await call("/api/admin/students/" + goneId, {
          method: "DELETE",
          cookie: admin,
        });
        assert.equal(stillScans.status, 409, "сканы ещё приложены");
        assert.ok(attachmentRow(scanId));

        const dropScan = await call("/api/admin/attachments/" + scanId, {
          method: "DELETE",
          cookie: admin,
        });
        assert.equal(dropScan.status, 200);
        const removed = await call("/api/admin/students/" + goneId, {
          method: "DELETE",
          cookie: admin,
        });
        assert.equal(removed.status, 200, await removed.clone().text());

        const again = await call("/api/admin/students", {
          method: "POST",
          cookie: admin,
          body: addBody,
        });
        assert.equal(again.status, 200, await again.clone().text());
        assert.equal((await again.json()).id, goneId, "id производится от ФИО");
        const card = await (
          await call("/api/admin/students/" + goneId, { cookie: admin })
        ).json();
        assert.equal(card.account, null);
        assert.deepEqual(card.attachments, []);
        assert.equal(
          (await call("/api/student/profile", { cookie: oidcCookie })).status,
          401,
        );
      },
    );
  } finally {
    child.kill("SIGTERM");
    await new Promise((r) => child.once("exit", r));
    rmSync(temp, { recursive: true, force: true });
  }
});
