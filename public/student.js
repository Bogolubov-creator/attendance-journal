// Личный кабинет студента: три раздела («Мои требования», «Мои данные»,
// «Моя посещаемость»), переключение вкладками. Загрузочный код (boot) не
// выполняется при импорте модуля – только когда на странице есть #student-app
// (реальная страница student.html), поэтому модуль безопасно импортировать в
// jsdom для проверки renderRequirements/renderProfile/renderAttendance.
// По умолчанию используется настоящей страницей (boot/toast); render*-функции
// экранируют строго через esc, который им передал вызывающий код – так же,
// как dailyJournal({ api, esc, toast }) в public/daily.js.
const defaultEsc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const ruDate = (d) => (d ? d.slice(0, 10).split("-").reverse().join(".") : "");
const fmtSize = (n) =>
  n < 1024 * 1024
    ? Math.round(n / 1024) + " КБ"
    : (n / 1024 / 1024).toFixed(1) + " МБ";
const todayMoscow = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
// Статусы требования – та же подпись, что и в карточке сотрудника (public/app.js).
const procedureLabels = {
  unknown: "Нет данных",
  pending: "Не выполнено",
  submitted: "На проверке",
  confirmed: "Подтверждено",
  exempt: "Не требуется",
  overdue: "Просрочено",
  expired: "Истёк срок действия",
};
const procDateText = (p) =>
  ["pending", "overdue", "submitted"].includes(p.status) && p.dueDate
    ? "до " + ruDate(p.dueDate)
    : ["confirmed", "expired"].includes(p.status) && p.validUntil
      ? "действует до " + ruDate(p.validUntil)
      : "";
// Подписи перечислений карточки – слово в слово как в карточке сотрудника (public/app.js).
const foreignStatusLabels = {
  unknown: "Не проверено",
  confirmed: "Подтверждён",
  excluded: "Не входит",
};
const enrollmentStatusLabels = {
  active: "Обучается",
  leave: "Академический отпуск",
  graduated: "Выпускник",
  withdrawn: "Отчислен",
};
const residenceLabels = {
  "": "Не указано",
  visa: "Виза",
  visa_free: "Безвизовый въезд",
  rvp: "РВП",
  rvpo: "РВПО",
  residence_permit: "ВНЖ",
  other: "Другое",
};
const inRussiaLabels = { "": "Не указано", yes: "Да", no: "Нет" };
const housingLabels = {
  "": "Не указано",
  dormitory: "Общежитие",
  private: "Частный адрес",
};

// Требование считается «закрытым» для правки, когда его подтвердил или
// освободил сотрудник – студент видит только объяснение, без формы.
function isLocked(r) {
  return (
    r.state === "exempt" || (r.state === "confirmed" && r.closedBy === "staff")
  );
}
function lockedExplanation(r) {
  return r.state === "exempt"
    ? "Учебный офис отметил: требование не нужно" +
        (r.note ? " – " + r.note : "") +
        "."
    : "Подтверждено учебным офисом" +
        (r.completedAt ? " " + ruDate(r.completedAt) : "") +
        ".";
}
function scanRow(a, locked, esc) {
  return `<div class="schedule-row"><div><a href="/api/attachments/${esc(a.id)}">${esc(a.fileName)}</a><small>${esc(ruDate(a.uploadedAt))} · ${esc(fmtSize(a.size))}</small></div>${
    locked
      ? ""
      : `<button type="button" class="btn small" data-delete-attachment="${esc(a.id)}" aria-label="Удалить файл ${esc(a.fileName)}">Удалить</button>`
  }</div>`;
}
function requirementCard(r, esc) {
  const locked = isLocked(r);
  const pillClass = ["overdue", "expired"].includes(r.status)
    ? "red"
    : r.status === "confirmed"
      ? "green"
      : "";
  // Политика видна студенту заранее: он знает, что случится после сохранения.
  const caption =
    r.closedBy === "student"
      ? "После сохранения требование будет отмечено выполненным."
      : "После сохранения документы уйдут на проверку в учебный офис.";
  return `<details class="procedure-item" ${["overdue", "expired"].includes(r.status) ? "open" : ""}>
    <summary><span class="proc-title">${esc(r.title)}</span><span class="pill ${pillClass}">${esc(procedureLabels[r.status] || r.status)}</span><span class="proc-date">${esc(procDateText(r))}</span><span class="proc-edit">${locked ? "" : "Изменить"}</span></summary>
    <p>${esc(r.hint)} <a href="${esc(r.source)}" target="_blank" rel="noopener">Инструкция ВШЭ ↗</a></p>
    ${(r.attachments || []).length ? `<div class="proc-scans">${r.attachments.map((a) => scanRow(a, locked, esc)).join("")}</div>` : ""}
    ${
      locked
        ? `<p class="notice">${esc(lockedExplanation(r))}</p>`
        : `<form data-requirement="${esc(r.id)}" class="profile-form"><fieldset><label>Дата выполнения<input type="date" name="completedAt" value="${esc(r.completedAt || "")}"></label><label>Действительно до<input type="date" name="validUntil" value="${esc(r.validUntil || "")}"></label><label class="wide">Номер / пояснение<textarea name="note" maxlength="1000" rows="2">${esc(r.note || "")}</textarea></label></fieldset><button class="btn primary small">${r.closedBy === "student" ? "Отметить выполненным" : "Отправить на проверку"}</button><p class="muted">${esc(caption)}</p><p class="form-status" role="status"></p></form><label class="upload-row">Приложить скан (PDF, JPEG, PNG)<input type="file" accept=".pdf,.jpg,.jpeg,.png" data-upload="${esc(r.id)}"></label>`
    }
  </details>`;
}
function requirementsHtml(requirements, esc) {
  return `<section class="panel daily-panel">${requirements.map((r) => requirementCard(r, esc)).join("")}</section>`;
}
// Последний список требований – источник версий для форм сохранения (задача 9,
// see implementer-rules: рендер возвращает строку, обвязка читает данные отсюда).
let lastRequirements = [];
export async function renderRequirements({ api, esc = defaultEsc }) {
  const { requirements } = await api("/api/student/requirements");
  lastRequirements = requirements;
  return requirementsHtml(requirements, esc);
}

function profileHtml(data, esc) {
  const s = data.student,
    editable = new Set(data.editable);
  const note = (name) =>
    editable.has(name)
      ? ""
      : '<small class="field-note">меняет учебный офис</small>';
  const input = (name, value, type = "text", extra = "") =>
    `<input name="${name}" type="${type}" value="${esc(value ?? "")}" ${editable.has(name) ? "" : "disabled"} ${extra}>`;
  const select = (name, value, labels) =>
    `<select name="${name}" ${editable.has(name) ? "" : "disabled"}>${Object.entries(
      labels,
    )
      .map(
        ([v, l]) =>
          `<option value="${esc(v)}" ${String(value ?? "") === v ? "selected" : ""}>${esc(l)}</option>`,
      )
      .join("")}</select>`;
  const row = (label, control, name) =>
    `<label>${label}${control}${note(name)}</label>`;
  return `<section class="panel daily-panel">
    <p class="muted">Открытые поля меняете вы; остальные меняет учебный офис.</p>
    <form id="profile-form" class="profile-form" data-version="${s.version || 0}">
      <fieldset>
        ${row("Программа", input("program", s.program), "program")}
        ${row("Курс", input("year", s.year || ""), "year")}
        ${row("Иностранный контингент", select("foreignStatus", s.foreignStatus || "unknown", foreignStatusLabels), "foreignStatus")}
        ${row("Обучение", select("enrollmentStatus", s.enrollmentStatus || "active", enrollmentStatusLabels), "enrollmentStatus")}
        ${row("Гражданство", input("citizenship", s.citizenship, "text", 'maxlength="100"'), "citizenship")}
        ${row("ФИО латиницей", input("nameLatin", s.nameLatin, "text", 'maxlength="200"'), "nameLatin")}
        ${row("Страна, направившая на обучение", input("sendingCountry", s.sendingCountry, "text", 'maxlength="200"'), "sendingCountry")}
        ${row("Дата въезда в РФ", input("arrivalDate", s.arrivalDate, "date"), "arrivalDate")}
        ${row("Основание пребывания", select("residence", s.residence || "", residenceLabels), "residence")}
        ${row("Паспорт действителен до", input("passportUntil", s.passportUntil, "date"), "passportUntil")}
        ${row("Миграционная карта до", input("migrationCardUntil", s.migrationCardUntil, "date"), "migrationCardUntil")}
        ${row("Проживание", select("housing", s.housing || "", housingLabels), "housing")}
        ${row("Находится в РФ", select("inRussia", s.inRussia || "", inRussiaLabels), "inRussia")}
      </fieldset>
      <button class="btn primary small">Сохранить</button>
      <p class="form-status" role="status"></p>
    </form>
  </section>`;
}
export async function renderProfile({ api, esc = defaultEsc }) {
  const data = await api("/api/student/profile");
  return profileHtml(data, esc);
}

function attendanceHtml(data, from, to, esc) {
  return `<section class="panel daily-panel">
    <p><strong>Не были ${data.absenceDays} учебных дней.</strong> Последняя явка: ${data.lastVisit ? esc(ruDate(data.lastVisit)) : "нет данных"}.</p>
    <p class="muted">Дни за период: с ${esc(ruDate(from))} по ${esc(ruDate(to))}.</p>
    ${
      data.days.length
        ? data.days
            .map(
              (d) =>
                `<div class="record"><div><strong>${esc(ruDate(d.date))}</strong></div><div>${d.marks
                  .map(
                    (m) =>
                      `<span class="pill ${m.status === "present" ? "green" : "red"}">${esc(m.course || "Без дисциплины")} · ${m.status === "present" ? "Присутствовал(а)" : "Отсутствовал(а)"}</span>`,
                  )
                  .join(" ")}</div></div>`,
            )
            .join("")
        : '<p class="muted">Отметок за период нет.</p>'
    }
  </section>`;
}
// По умолчанию – текущий календарный месяц (с 1 числа по сегодня, время московское).
export async function renderAttendance({ api, esc = defaultEsc }) {
  const to = todayMoscow();
  const from = to.slice(0, 8) + "01";
  const data = await api(
    "/api/student/attendance?" + new URLSearchParams({ from, to }),
  );
  return attendanceHtml(data, from, to, esc);
}

// --- Ниже – код настоящей страницы. Не выполняется при импорте модуля в тестах. ---
const esc = defaultEsc;
async function api(path, options = {}) {
  const r = await fetch(path, {
    signal: AbortSignal.timeout(25000),
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  let data;
  try {
    data = await r.json();
  } catch {
    throw Error("Сервер недоступен. Повторите запрос.");
  }
  if (!r.ok) {
    if (r.status === 401) location.replace("/");
    throw Object.assign(Error(data.error || "Не удалось выполнить запрос"), {
      status: r.status,
    });
  }
  return data;
}
let toastTimer;
function toast(message, error = false) {
  const el = document.querySelector("#toast");
  if (!el) return;
  el.innerHTML =
    `<span>${esc(message)}</span>` +
    (error
      ? '<button type="button" class="toast-close" aria-label="Закрыть уведомление">×</button>'
      : "");
  el.className = "show" + (error ? " error" : "");
  el.setAttribute("role", error ? "alert" : "status");
  const hide = () => {
    el.className = "";
    if (el.matches(":popover-open")) el.hidePopover();
  };
  if (el.showPopover && !el.matches(":popover-open")) el.showPopover();
  clearTimeout(toastTimer);
  if (error) el.querySelector(".toast-close").onclick = hide;
  else toastTimer = setTimeout(hide, 5500);
}
async function safe(fn) {
  try {
    await fn();
  } catch (e) {
    toast(e.message, true);
  }
}
async function uploadScan(kind, file) {
  const r = await fetch(
    "/api/student/attachments/" + encodeURIComponent(kind),
    {
      method: "POST",
      headers: {
        "content-type": file.type || "application/octet-stream",
        "x-file-name": encodeURIComponent(file.name),
      },
      body: file,
    },
  );
  let data;
  try {
    data = await r.json();
  } catch {
    data = {};
  }
  if (!r.ok)
    throw Object.assign(Error(data.error || "Не удалось загрузить файл"), {
      status: r.status,
    });
  return data;
}
let activeTab = "requirements";
async function showTab() {
  document
    .querySelectorAll(".cabinet-tabs [data-tab]")
    .forEach((b) =>
      b.setAttribute("aria-selected", String(b.dataset.tab === activeTab)),
    );
  const container = document.querySelector("#tab-content");
  try {
    if (activeTab === "requirements") {
      container.innerHTML = await renderRequirements({ api, esc });
      bindRequirements(container);
    } else if (activeTab === "profile") {
      container.innerHTML = await renderProfile({ api, esc });
      bindProfile(container);
    } else {
      container.innerHTML = await renderAttendance({ api, esc });
    }
  } catch (e) {
    container.innerHTML = "";
    toast(e.message, true);
  }
}
function bindRequirements(container) {
  container.querySelectorAll("[data-requirement]").forEach((form) => {
    const rule = lastRequirements.find(
      (r) => r.id === form.dataset.requirement,
    );
    form.onsubmit = (e) => {
      e.preventDefault();
      const status = form.querySelector(".form-status"),
        button = form.querySelector("button");
      const body = Object.fromEntries(new FormData(form));
      button.disabled = true;
      status.textContent = "Сохраняем…";
      api("/api/student/requirements/" + encodeURIComponent(rule.id), {
        method: "PUT",
        body: JSON.stringify({
          ...body,
          state: rule.closedBy === "student" ? "confirmed" : "submitted",
          version: rule.version || 0,
        }),
      })
        .then(() => {
          toast("Сохранено");
          return showTab();
        })
        .catch((e) => {
          status.textContent = e.message;
          if (button.isConnected) button.disabled = false;
        });
    };
  });
  container.querySelectorAll("[data-upload]").forEach((input) => {
    input.onchange = () => {
      const file = input.files[0];
      if (!file) return;
      input.disabled = true;
      uploadScan(input.dataset.upload, file)
        .then(() => {
          toast("Файл приложен");
          return showTab();
        })
        .catch((e) => {
          toast(e.message, true);
          input.disabled = false;
        });
    };
  });
  container.querySelectorAll("[data-delete-attachment]").forEach((button) => {
    button.onclick = () =>
      safe(async () => {
        await api(
          "/api/student/attachments/" + button.dataset.deleteAttachment,
          {
            method: "DELETE",
          },
        );
        toast("Файл удалён");
        await showTab();
      });
  });
}
function bindProfile(container) {
  const form = container.querySelector("#profile-form");
  if (!form) return;
  form.onsubmit = (e) => {
    e.preventDefault();
    const status = form.querySelector(".form-status"),
      button = form.querySelector("button");
    const body = Object.fromEntries(new FormData(form));
    button.disabled = true;
    status.textContent = "Сохраняем…";
    api("/api/student/profile", {
      method: "PUT",
      body: JSON.stringify({
        ...body,
        version: Number(form.dataset.version) || 0,
      }),
    })
      .then(() => {
        toast("Сохранено");
        return showTab();
      })
      .catch((e) => {
        status.textContent = e.message;
        if (button.isConnected) button.disabled = false;
      });
  };
}
async function boot() {
  const app = document.querySelector("#student-app");
  let session;
  try {
    session = await api("/api/session");
  } catch (e) {
    app.innerHTML =
      '<div class="error-box">Не удалось открыть кабинет. Обновите страницу.</div>';
    toast(e.message, true);
    return;
  }
  // Роль не студент – зеркально app.js, который уводит студента на /student.html:
  // тут уводим всех остальных на главную страницу журнала.
  if (!session.user || session.user.role !== "student") {
    location.replace("/");
    return;
  }
  const user = session.user;
  app.innerHTML = `<div class="topbar"><span class="crumb">Кабинет студента <b>${esc(user.name)}</b></span>${session.demo ? '<span class="demo-tag">Локальный просмотр · тестовые данные</span>' : ""}<button id="logout" class="btn small" type="button">Выйти</button></div><div class="content"><div class="page-heading"><div><div class="eyebrow">Факультет права</div><h1>Личный кабинет</h1><p>Требования, ваши данные и посещаемость.</p></div></div><nav class="card-tabs cabinet-tabs" role="tablist" aria-label="Разделы кабинета"><button type="button" role="tab" data-tab="requirements">Мои требования</button><button type="button" role="tab" data-tab="profile">Мои данные</button><button type="button" role="tab" data-tab="attendance">Моя посещаемость</button></nav><div id="tab-content"></div></div>`;
  document.querySelector("#logout").onclick = () =>
    safe(async () => {
      await api("/api/logout", { method: "POST" });
      location.replace("/");
    });
  document.querySelectorAll(".cabinet-tabs [data-tab]").forEach(
    (b) =>
      (b.onclick = () => {
        activeTab = b.dataset.tab;
        safe(showTab);
      }),
  );
  await showTab();
}
if (document.querySelector("#student-app")) boot();
