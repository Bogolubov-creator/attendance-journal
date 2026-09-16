const $ = (s) => document.querySelector(s),
  root = $("#app");
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const labels = { present: "Присутствовал", absent: "Отсутствовал" };
const symbols = { present: "✓", absent: "×" };
let syncError = "";
let session,
  user,
  page = "journal",
  lessons = [],
  selected = null,
  current = null,
  marks = {},
  dirty = false,
  overview,
  filter = "all",
  query = "",
  teacherSearch = "",
  lastSave = "",
  toastTimer,
  tablePage = 0;
let autosaveTimer,
  savePromise,
  editSequence = 0,
  saveConflict = false,
  automation;
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
    if (r.status === 401) {
      user = null;
      loginView();
    }
    throw Object.assign(Error(data.error || "Не удалось выполнить запрос"), {
      status: r.status,
    });
  }
  return data;
}
function toast(message, error = false) {
  const el = $("#toast");
  el.textContent = message;
  el.className = "show" + (error ? " error" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = ""), 5500);
}
async function safe(fn) {
  try {
    await fn();
  } catch (e) {
    toast(e.message, true);
  }
}
function fmtDate(d, options = { day: "numeric", month: "long" }) {
  return new Intl.DateTimeFormat("ru-RU", {
    ...options,
    timeZone: "Europe/Moscow",
  }).format(new Date(d.length === 10 ? d + "T12:00:00+03:00" : d));
}
const initials = (n) =>
  n
    .split(" ")
    .slice(0, 2)
    .map((x) => x[0])
    .join("");
const brand =
  '<div class="brand" aria-label="Факультет права – учебный журнал"><span class="brand-icon" aria-hidden="true">ФП</span><span class="brand-name">Факультет<br>права<small>Учебный журнал</small></span></div>';
const search = (id, placeholder, value = "") =>
  `<div class="search"><input id="${id}" type="search" placeholder="${placeholder}" aria-label="${placeholder}" value="${esc(value)}"></div>`;
function loginView() {
  root.innerHTML = `<div class="login"><section class="login-art">${brand}<div><h2 class="login-title">Каждый студент.<br>В поле внимания.</h2><p>Посещаемость и обязательные процедуры.<br>Общая картина для факультета права.</p></div><small>Расписание · Посещаемость · Сопровождение</small></section><section class="login-main"><div class="login-box"><div class="eyebrow">Факультет права</div><h1>Ваш рабочий кабинет</h1><p>Выберите роль и своё имя. Преподавателю откроется журнал, руководству – студенты и процедуры.</p>${session.selection ? `<form id="select-login" class="access-form"><label for="login-role">Роль</label><select id="login-role"><option value="teacher">Преподаватель</option><option value="office">Руководство · менеджер</option><option value="admin">Руководство · полный доступ</option></select><label for="person-search">Поиск сотрудника</label><input id="person-search" type="search" placeholder="Начните вводить фамилию"><label for="login-person">Сотрудник</label><select id="login-person" required></select><label id="password-label" for="management-password" hidden>Пароль руководства</label><input id="management-password" type="password" autocomplete="current-password" maxlength="256" hidden><p id="person-scope" class="muted" aria-live="polite"></p><button class="btn primary">Открыть кабинет →</button></form><div class="login-footer">Преподаватель входит по выбору имени. Руководство – по паролю.${session.demo ? " Локальный просмотр: отметки сохраняются в тестовой базе." : ""}</div>` : '<a class="btn primary" href="/auth/login">Войти</a>'}</div></section></div>`;
  if (!session.selection) return;
  const updateSelection = (hint = "Выберите сотрудника из списка.") => {
    const personId = $("#login-person").value;
    const person = [...session.teachers, ...session.managers].find(
      (p) => p.id === personId,
    );
    const m = session.managers.find((p) => p.id === personId);
    $("#select-login button").disabled = !personId;
    $("#person-scope").textContent = person
      ? "Выбран: " +
        person.name +
        (m
          ? ". " +
            (m.title ? m.title + ". " : "") +
            m.scopes
              .map((s) => s.program + (s.year ? ", " + s.year + " курс" : ""))
              .join(" · ")
          : "")
      : hint;
  };
  const fill = () => {
    const previous = $("#login-person").value;
    const role = $("#login-role").value,
      q = $("#person-search")
        .value.trim()
        .toLocaleLowerCase("ru")
        .replace(/ё/g, "е");
    const people = (
      role === "teacher"
        ? session.teachers
        : session.managers.filter((m) => m.role === role)
    )
      .filter((p) =>
        p.name.toLocaleLowerCase("ru").replace(/ё/g, "е").includes(q),
      )
      .sort((a, b) => a.name.localeCompare(b.name, "ru"));
    const needsPassword = role !== "teacher";
    $("#password-label").hidden = !needsPassword;
    $("#management-password").hidden = !needsPassword;
    $("#management-password").required = needsPassword;
    $("#login-person").innerHTML =
      '<option value="">Выберите своё имя</option>' +
      people
        .map((p) => `<option value="${p.id}">${esc(p.name)}</option>`)
        .join("");
    if (q && people.length === 1) $("#login-person").value = people[0].id;
    else if (people.some((p) => p.id === previous))
      $("#login-person").value = previous;
    updateSelection(
      people.length
        ? "Выберите сотрудника из списка ниже поля поиска."
        : "Сотрудник не найден. Проверьте фамилию или выбранную роль.",
    );
  };
  $("#login-role").onchange = () => {
    $("#person-search").value = "";
    $("#management-password").value = "";
    fill();
  };
  $("#person-search").oninput = fill;
  $("#login-person").onchange = () => updateSelection();
  $("#select-login").onsubmit = (e) => {
    e.preventDefault();
    safe(async () => {
      const button = e.target.querySelector("button");
      button.disabled = true;
      try {
        const r = await api("/api/select-login", {
          method: "POST",
          body: JSON.stringify({
            role: $("#login-role").value,
            personId: $("#login-person").value,
            password:
              $("#login-role").value === "teacher"
                ? undefined
                : $("#management-password").value,
          }),
        });
        user = r.user;
        officeScope = user.role === "office" ? "mine" : "all";
        officeProgram = "";
        officeYear = "";
        page = user.role === "teacher" ? "journal" : "dashboard";
        syncError = "";
        selected = null;
        filter = "all";
        query = "";
        tablePage = 0;
        await showApp();
      } finally {
        button.disabled = false;
      }
    });
  };
  fill();
}
function shell() {
  root.innerHTML = `<div class="layout"><aside class="sidebar">${brand}<div class="section-label">${user.role !== "teacher" ? "Руководство" : "Преподаватель"}</div><nav class="nav" aria-label="Основная навигация">${user.role !== "teacher" ? `<button data-page="dashboard" class="${page === "dashboard" ? "active" : ""}"><span class="nav-icon">▦</span>Обзор</button><button data-page="students" class="${page === "students" ? "active" : ""}"><span class="nav-icon">♙</span>Студенты</button><button data-page="automation" class="${page === "automation" ? "active" : ""}"><span class="nav-icon">↻</span>Сбор данных</button>` : `<button data-page="journal" class="active"><span class="nav-icon">▤</span>Мой журнал</button>`}</nav><div class="side-bottom"><div class="side-note">${user.role !== "teacher" ? "Студенты, которым нужна поддержка, собраны в одном месте." : "Отметьте присутствие. Журнал сохраняется автоматически."}<br><br><a href="https://ruz.hse.ru/ruz/main" target="_blank" rel="noopener">Открыть РУЗ ↗</a></div><div class="identity"><span class="avatar">${initials(user.name)}</span><div><strong>${esc(user.name.split(" ").slice(0, 2).join(" "))}</strong><small>${user.role !== "teacher" ? "Руководство" : "Преподаватель"}</small></div></div><button id="logout" class="logout">Выйти ↗</button></div></aside><main class="main"><header class="topbar"><span class="crumb">Учебный процесс <b>/ ${user.role !== "teacher" ? "Руководство" : "Посещаемость"}</b></span>${session.demo ? '<span class="demo-tag">Локальный просмотр · тестовые отметки</span>' : ""}</header><div class="content" id="content"></div></main></div>`;
  $$("[data-page]").forEach(
    (b) =>
      (b.onclick = () =>
        safe(async () => {
          page = b.dataset.page;
          query = "";
          filter = "all";
          tablePage = 0;

          await showApp();
        })),
  );
  $("#logout").onclick = () =>
    safe(async () => {
      await flushSave();
      await api("/api/logout", { method: "POST" });
      dirty = false;
      user = null;
      loginView();
    });
}
const $$ = (s) => [...document.querySelectorAll(s)];
async function showApp() {
  shell();
  $("#content").innerHTML = '<div class="loading">Загружаем данные…</div>';
  if (user.role !== "teacher") {
    overview = await api("/api/admin/overview");
    if (page === "automation") {
      automation = await api("/api/admin/automation");
      automationView();
    } else adminView();
  } else {
    await loadLessons();
    if (
      !lessons.length ||
      !session.syncedAt ||
      Date.now() - Date.parse(session.syncedAt) > 300000
    ) {
      $("#content").innerHTML =
        '<div class="loading">Загружаем расписание из РУЗ…</div>';
      try {
        await api("/api/ruz/sync", { method: "POST", body: "{}" });
        await loadLessons();
        syncError = "";
      } catch (e) {
        syncError = e.message;
        toast(e.message, true);
      }
    }
    journalView();
  }
}
async function loadLessons() {
  const r = await api("/api/lessons");
  lessons = r.lessons;
  session.syncedAt = r.sync?.at;
  if (!selected || !lessons.some((l) => l.id === selected))
    selected = lessons[0]?.id || null;
  if (selected) await loadCurrent();
  else current = null;
}
async function loadCurrent() {
  current = await api("/api/lessons/" + selected);
  clearTimeout(autosaveTimer);
  saveConflict = false;
  editSequence = 0;
  marks = Object.fromEntries(
    current.marks.map((m) => [
      m.studentId,
      { status: m.status, note: m.note || "" },
    ]),
  );
  dirty = false;
  teacherSearch = "";
  lastSave = "";
}
function lessonState(l) {
  const now = new Date(),
    start = new Date(`${l.date}T${l.start}:00+03:00`),
    end = new Date(`${l.date}T${l.end}:00+03:00`);
  if (l.marked && l.marked === l.studentCount) return ["done", "Заполнено"];
  if (start <= now && end >= now) return ["now", "Сейчас"];
  if (start > now) return ["", "Предстоит"];
  return ["", l.marked ? "Частично" : "Не заполнено"];
}
function journalView() {
  const content = $("#content");
  content.innerHTML = `<div class="page-heading"><div><div class="eyebrow">Кабинет преподавателя</div><h1>Мой журнал</h1><p>${esc(user.name)}</p></div><button class="btn" id="sync">↻ Обновить из РУЗ</button></div><div class="date-strip"><div><strong>${fmtDate(new Date().toISOString(), { weekday: "long", day: "numeric", month: "long" })}</strong><small>Время московское</small></div><div class="sync-info">${session.syncedAt ? `<span class="dot"></span>РУЗ обновлён ${fmtDate(session.syncedAt, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}` : "Расписание ещё не загружено"}</div></div>${
    syncError
      ? `<div class="panel" role="alert"><h3>Расписание не обновлено</h3><p>${esc(syncError)}</p></div>`
      : ""
  }${
    !lessons.length
      ? `<div class="panel empty"><h3>${syncError ? "Не удалось загрузить занятия" : session.syncedAt ? "Нет подходящих занятий" : "Расписание ещё не загружено"}</h3><p>Показываем только пары, где есть студенты из отслеживаемого списка. Остальное расписание скрыто.</p><button id="empty-sync" class="btn primary">Загрузить расписание</button></div>`
      : `<div class="journal-grid"><aside><div class="schedule-title"><span>Занятия</span><span class="muted">${lessons.length}</span></div><div class="schedule">${lessons
          .map((l) => {
            const [cls, label] = lessonState(l);
            return `<button data-lesson="${l.id}" class="lesson-card ${selected === l.id ? "selected" : ""}" aria-pressed="${selected === l.id}"><div class="lesson-time">${l.start}<span>${l.end}</span></div><small>${fmtDate(l.date, { weekday: "short", day: "numeric", month: "short" })}</small><strong>${esc(l.course.replace(/ \(рус\)$/, ""))}</strong><small>${esc(l.kind)}${l.room ? " · ауд. " + esc(l.room) : ""}</small><div class="lesson-foot"><span class="status-label ${cls}">${label}</span><small>${l.studentCount} в списке</small></div></button>`;
          })
          .join(
            "",
          )}</div><p class="footer-note">Только пары со студентами из отслеживаемого списка. Сначала текущая, затем ближайшие.</p></aside><section class="journal" id="journal"></section></div>`
  }`;
  $("#sync").onclick = sync;
  if ($("#empty-sync")) $("#empty-sync").onclick = sync;
  $$("[data-lesson]").forEach(
    (b) =>
      (b.onclick = () =>
        safe(async () => {
          await flushSave();
          selected = b.dataset.lesson;
          await loadCurrent();
          journalView();
        })),
  );
  if (current) renderJournal();
}
async function sync() {
  try {
    await flushSave();
  } catch (e) {
    toast(e.message, true);
    return;
  }
  const b = $("#sync");
  b.disabled = true;
  b.textContent = "Сверяем с РУЗ…";
  await safe(async () => {
    let r;
    try {
      r = await api("/api/ruz/sync", { method: "POST", body: "{}" });
      syncError = "";
    } catch (e) {
      syncError = e.message;
      journalView();
      throw e;
    }
    await loadLessons();
    journalView();
    toast(
      r.cached
        ? "Расписание уже актуально"
        : `Загружено занятий: ${r.count}. Со студентами из Excel: ${r.matched}.`,
    );
  });
  if (b.isConnected) {
    b.disabled = false;
    b.textContent = "↻ Обновить из РУЗ";
  }
}
function renderJournal() {
  const l = current.lesson;
  const future = new Date(`${l.date}T${l.start}:00+03:00`) > new Date();
  $("#journal").innerHTML =
    `<div class="journal-head"><div class="eyebrow">${esc(l.kind)} · ${fmtDate(l.date, { day: "numeric", month: "long" })}</div><h2>${esc(l.course.replace(/ \(рус\)$/, ""))}</h2><div class="metadata"><span>◷ ${l.start}–${l.end}</span>${l.room ? `<span>Аудитория ${esc(l.room)}</span>` : ""}<span>${esc(l.building)}</span></div>${l.scheduleRemoved ? '<div class="notice warn">Пара больше не найдена в РУЗ. Сохранённые отметки оставлены для проверки.</div>' : ""}${future ? '<div class="notice">Занятие ещё не началось. Отмечать посещение можно с начала пары.</div>' : ""}<div class="journal-counts" id="counts"></div></div>${current.students.length ? `<div class="toolbar">${search("student-search", "Найти студента", teacherSearch)}<button class="btn small" id="mark-all" ${future ? "disabled" : ""}>✓ Все присутствуют</button></div><div class="table-head"><span>№</span><span>Студент</span><span>Посещение</span></div><div id="rows"></div><div class="legend"><span><b>✓</b> Присутствовал</span><span><b>×</b> Отсутствовал</span></div><div class="save-bar"><small id="save-state">Отметки сохраняются автоматически</small><button class="btn primary" id="save" disabled>Сохранить журнал</button></div>` : `<div class="empty"><h3>В Excel нет студентов этой пары</h3><p>Сопоставление проверяет дисциплину и учебную группу. Для отметок нужен подтверждённый список.</p><a class="btn" href="https://ruz.hse.ru/ruz/main" target="_blank" rel="noopener">Проверить в РУЗ ↗</a></div>`}<div class="legend">Только отслеживаемые студенты. Остальной состав группы не отображается.</div>`;
  renderCounts();
  if (current.students.length) {
    renderRows();
    $("#student-search").oninput = (e) => {
      teacherSearch = e.target.value;
      renderRows();
    };
    $("#mark-all").onclick = () => {
      current.students.forEach(
        (s) =>
          (marks[s.id] = { status: "present", note: marks[s.id]?.note || "" }),
      );
      changed();
      renderRows();
    };
    $("#save").onclick = () => safe(save);
  }
}
function renderCounts() {
  const values = Object.values(marks).filter((m) => m.status),
    present = values.filter((m) => m.status === "present").length;
  $("#counts").innerHTML =
    `<div><strong>${current.students.length}</strong><small>В списке</small></div><div><strong>${present}</strong><small>Присутствуют</small></div><div><strong>${values.filter((m) => m.status === "absent").length}</strong><small>Отсутствуют</small></div><div><strong>${current.students.length - values.length}</strong><small>Без отметки</small></div>`;
}
function renderRows() {
  const future =
      new Date(`${current.lesson.date}T${current.lesson.start}:00+03:00`) >
      new Date(),
    rows = current.students.filter((s) =>
      s.name.toLowerCase().includes(teacherSearch.toLowerCase()),
    );
  $("#rows").innerHTML = rows.length
    ? rows
        .map((s) => {
          const index = current.students.findIndex((x) => x.id === s.id) + 1;
          return `<div class="student-row"><span class="index">${String(index).padStart(2, "0")}</span><div><div class="student-name">${esc(s.name)}</div><div class="student-sub">${marks[s.id]?.status ? labels[marks[s.id].status] : "Не отмечен"}</div></div><div class="mark-controls" role="group" aria-label="Посещение: ${esc(s.name)}">${Object.keys(
            labels,
          )
            .map(
              (status) =>
                `<button class="mark ${status} ${marks[s.id]?.status === status ? "on" : ""}" data-student="${s.id}" data-status="${status}" aria-label="${labels[status]}: ${esc(s.name)}" aria-pressed="${marks[s.id]?.status === status}" title="${labels[status]}" ${future ? "disabled" : ""}>${symbols[status]}</button>`,
            )
            .join("")}</div></div>`;
        })
        .join("")
    : '<div class="empty">Студенты не найдены. Измените запрос.</div>';
  $$("[data-status]").forEach(
    (b) =>
      (b.onclick = () => {
        const id = b.dataset.student,
          status = b.dataset.status;
        marks[id] = {
          status: marks[id]?.status === status ? null : status,
          note: marks[id]?.note || "",
        };
        changed();
        renderRows();
      }),
  );
}
function changed() {
  dirty = true;
  editSequence++;
  renderCounts();
  $("#save").disabled = false;
  $("#save-state").textContent = saveConflict
    ? "Конфликт версии. Обновите журнал."
    : "Сохраняем автоматически…";
  if (!saveConflict) {
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => safe(save), 600);
  }
}
async function flushSave() {
  clearTimeout(autosaveTimer);
  if (savePromise) await savePromise;
  while (dirty) await save();
}
async function save() {
  clearTimeout(autosaveTimer);
  if (savePromise) return savePromise;
  if (!dirty) return;
  if (saveConflict)
    throw Error(
      "Журнал изменён в другой вкладке. Скопируйте свои изменения и обновите страницу.",
    );
  const id = selected,
    seq = editSequence,
    payload = {
      version: current.version,
      marks: Object.entries(marks).map(([studentId, m]) => ({
        studentId,
        ...m,
      })),
    };
  const b = $("#save");
  if (b) {
    b.disabled = true;
    b.textContent = "Сохраняем…";
  }
  savePromise = (async () => {
    try {
      const r = await api("/api/lessons/" + id + "/marks", {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      current.version = r.version;
      dirty = seq !== editSequence;
      lastSave = r.savedAt;
      const state = $("#save-state");
      if (state)
        state.textContent = dirty
          ? "Сохраняем следующие отметки…"
          : "Автоматически сохранено в " +
            fmtDate(lastSave, { hour: "2-digit", minute: "2-digit" });
      const item = lessons.find((l) => l.id === id);
      if (item)
        item.marked = Object.values(marks).filter((m) => m.status).length;
    } catch (e) {
      saveConflict = e.status === 409;
      const state = $("#save-state");
      if (state)
        state.textContent = saveConflict
          ? "Конфликт версии. Обновите журнал."
          : "Не сохранено. Проверьте связь и нажмите «Сохранить».";
      throw e;
    } finally {
      savePromise = null;
      if (b?.isConnected) {
        b.textContent = "Сохранить журнал";
        b.disabled = !dirty;
      }
    }
  })();
  await savePromise;
  if (dirty && !saveConflict) autosaveTimer = setTimeout(() => safe(save), 100);
}
window.addEventListener("online", () => {
  if (dirty && !saveConflict) safe(save);
});
const procedureLabels = {
  unknown: "Нет данных",
  pending: "Не выполнено",
  submitted: "На проверке",
  confirmed: "Подтверждено",
  exempt: "Не требуется",
  overdue: "Просрочено",
  expired: "Истёк срок действия",
};
let officeScope = "all",
  officeProgram = "",
  officeYear = "";
const activeForeign = (s) =>
  s.foreignStatus === "confirmed" &&
  (!s.enrollmentStatus || s.enrollmentStatus === "active");
function adminView() {
  const students = overview.students,
    faculty = students.filter(activeForeign);
  const attention = faculty.filter((s) => s.absenceAlert),
    overdue = faculty.filter((s) => s.procedureOverdue);
  const programs = [
    ...new Set(students.map((s) => s.program).filter(Boolean)),
  ].sort();
  const list = (title, rows, type) =>
    `<section class="panel mini-panel"><h2>${title} <span class="muted">${rows.length}</span></h2>${
      rows.length
        ? rows
            .slice(0, 5)
            .map(
              (s) =>
                `<div class="record"><div><button class="student-link" data-profile="${s.id}">${esc(s.name)}</button><small>${esc(s.manager?.name || "Менеджер не назначен")}</small></div><span class="pill red">${type === "absence" ? s.days + " уч. дней" : s.procedureOverdue + " процедур"}</span></div>`,
            )
            .join("")
        : '<p class="muted">В подтверждённом контингенте таких записей нет.</p>'
    }${rows.length > 5 ? `<button class="btn small" data-filter="${type === "absence" ? "attention" : "debt"}">Показать весь список</button>` : ""}</section>`;
  $("#content").innerHTML =
    `<div class="page-heading"><div><div class="eyebrow">Руководство · Факультет права</div><h1>${page === "dashboard" ? "Иностранные студенты" : "Реестр студентов"}</h1><p>Общая статистика факультета. Работа со студентами – по программам и курсам.</p></div><a class="btn" href="/api/admin/export">↓ Выгрузить CSV</a></div>
  <div class="metrics"><div class="metric"><label>Иностранцев факультета</label><strong>${faculty.length}</strong><small>Подтверждённые, обучаются сейчас</small></div><div class="metric alert"><label>7 дней без явки</label><strong>${attention.length}</strong><small>По отметкам преподавателей</small></div><div class="metric alert"><label>Просрочены процедуры</label><strong>${overdue.length}</strong><small>Студентов, а не документов</small></div><div class="metric"><label>Нет данных о процедурах</label><strong>${faculty.filter((s) => s.procedureUnknown).length}</strong><small>Нужна проверка руководства</small></div></div>
  ${overview.faculty.unverified ? `<div class="notice">Полнота реестра ещё не подтверждена. Загружено ${students.length} студентов; иностранный статус не проверен у ${overview.faculty.unverified}. Они видны в реестре, но не включены в статистику иностранцев. Программы и курсы заполняет руководство.</div>` : ""}
  ${page === "dashboard" ? `<div class="attention-grid">${list("Не посещают занятия", attention, "absence")}${list("Должники по процедурам", overdue, "procedure")}</div>` : ""}
  <div class="admin-columns"><div class="panel"><div class="panel-heading"><div><h2>Реестр и списки внимания</h2><small>Статистика сверху всегда по факультету, фильтры действуют на таблицу</small></div>${search("admin-search", "Поиск по ФИО", query)}</div>
  <div class="office-filters"><label>Ответственность<select id="office-scope"><option value="all">Весь факультет</option><option value="mine">Мои программы и курсы</option><option value="unassigned">Не распределены</option></select></label><label>Программа<select id="office-program"><option value="">Все программы</option>${programs.map((p) => `<option>${esc(p)}</option>`).join("")}</select></label><label>Курс<select id="office-year"><option value="">Все курсы</option>${[1, 2, 3, 4, 5, 6].map((y) => `<option>${y}</option>`).join("")}</select></label></div>
  <div class="filter-tabs">${[
    ["all", "Весь реестр"],
    ["foreign", "Подтверждённые иностранцы"],
    ["attention", "7 дней без явки"],
    ["debt", "Просрочены процедуры"],
    ["combined", "Обе проблемы"],
    ["review", "На проверке"],
    ["unknown", "Нет данных о процедурах"],
    ["unverified", "Статус не проверен"],
    ["unmarked", "Нет отметок"],
  ]
    .map(
      ([id, label]) =>
        `<button data-filter="${id}" class="${filter === id ? "active" : ""}">${label}</button>`,
    )
    .join("")}</div>
  <div class="table-scroll"><table class="admin-table"><thead><tr><th>Студент / менеджер</th><th>Посещение</th><th>Без явки</th><th>Процедуры</th></tr></thead><tbody id="admin-rows"></tbody></table></div><div class="pagination"><small id="result-count"></small><div class="actions"><button class="btn small" id="prev-page" aria-label="Предыдущая страница">←</button><button class="btn small" id="next-page" aria-label="Следующая страница">→</button></div></div></div>
  <aside class="admin-aside"><section class="panel mini-panel"><h3>Ваш участок</h3><p>${esc(user.scopes?.map((s) => s.program + (s.year ? ", " + s.year + " курс" : "")).join(" · ") || "Весь факультет")}</p><a href="https://pravo.hse.ru/centre/contact" target="_blank" rel="noopener">Распределение менеджеров ↗</a><p>Сверено 16.09.2026. Изменения состава требуют обновления справочника.</p></section><section class="panel mini-panel"><h3>Полнота данных</h3><div class="quality-row"><span>Без менеджера</span><strong>${overview.faculty.unassigned}</strong></div><div class="quality-row"><span>Пар с отметками</span><strong>${overview.markedLessons} / ${overview.lessons}</strong></div><p>Нет отметки – не значит отсутствовал. Несколько пропусков за день считаются одним учебным днём.</p></section><section class="panel mini-panel"><h3>Сопровождение иностранцев</h3><p>Применимость процедур проверяется индивидуально: гражданство, основание пребывания, дата въезда и действующие подтверждения.</p><a href="https://ivisa.hse.ru/" target="_blank" rel="noopener">Визовая поддержка ↗</a><p><a href="https://istudents.hse.ru/" target="_blank" rel="noopener">Сервисы и инструкции для иностранцев ↗</a></p><p>Поддержка: istudents.support@hse.ru</p><p>Электронный пропуск, связь и адаптация – сервисные вопросы, они не создают долг по обязательной процедуре.</p></section></aside></div>`;
  $("#office-scope").value = officeScope;
  $("#office-program").value = officeProgram;
  $("#office-year").value = officeYear;
  $("#office-scope").onchange = (e) => {
    officeScope = e.target.value;
    tablePage = 0;
    renderAdminRows();
  };
  $("#office-program").onchange = (e) => {
    officeProgram = e.target.value;
    tablePage = 0;
    renderAdminRows();
  };
  $("#office-year").onchange = (e) => {
    officeYear = e.target.value;
    tablePage = 0;
    renderAdminRows();
  };
  $("#admin-search").oninput = (e) => {
    query = e.target.value;
    tablePage = 0;
    renderAdminRows();
  };
  $$("[data-filter]").forEach(
    (b) =>
      (b.onclick = () => {
        filter = b.dataset.filter;
        tablePage = 0;
        adminView();
      }),
  );
  renderAdminRows();
}
function renderAdminRows() {
  const rows = overview.students
    .filter(
      (s) =>
        s.name.toLowerCase().includes(query.toLowerCase()) &&
        (!officeProgram || s.program === officeProgram) &&
        (!officeYear || s.year === Number(officeYear)) &&
        (officeScope === "mine"
          ? s.manager?.id === user.id
          : officeScope === "unassigned"
            ? !s.manager
            : true) &&
        (filter === "foreign"
          ? activeForeign(s)
          : filter === "attention"
            ? activeForeign(s) && s.absenceAlert
            : filter === "debt"
              ? activeForeign(s) && s.procedureOverdue
              : filter === "combined"
                ? activeForeign(s) && s.absenceAlert && s.procedureOverdue
                : filter === "review"
                  ? s.procedureReview
                  : filter === "unknown"
                    ? s.procedureUnknown
                    : filter === "unverified"
                      ? !s.foreignStatus || s.foreignStatus === "unknown"
                      : filter === "unmarked"
                        ? !s.marked
                        : true),
    )
    .sort(
      (a, b) =>
        Number(b.absenceAlert) - Number(a.absenceAlert) ||
        b.procedureOverdue - a.procedureOverdue ||
        a.name.localeCompare(b.name, "ru"),
    );
  tablePage = Math.min(tablePage, Math.max(0, Math.ceil(rows.length / 20) - 1));
  $("#admin-rows").innerHTML = rows.length
    ? rows
        .slice(tablePage * 20, (tablePage + 1) * 20)
        .map(
          (s) =>
            `<tr><td><button class="student-link" data-profile="${s.id}">${esc(s.name)}</button><div class="student-sub">${esc(s.program || "Программа не указана")}${s.year ? " · " + s.year + " курс" : ""}<br>${esc(s.manager?.name || "Менеджер не назначен")}<br>${s.foreignStatus === "confirmed" ? "Иностранный статус подтверждён" : s.foreignStatus === "excluded" ? "Не входит в иностранный контингент" : "Иностранный статус не проверен"}</div></td><td>${s.attendance === null ? '<span class="muted">Нет отметок</span>' : s.attendance + "%"}</td><td><span class="pill ${s.absenceAlert ? "red" : ""}">${s.days} уч. дн.</span></td><td>${s.procedureOverdue ? `<span class="pill red">Просрочено: ${s.procedureOverdue}</span>` : ""}${s.procedureReview ? `<div class="student-sub">На проверке: ${s.procedureReview}</div>` : ""}${s.procedureUnknown ? `<div class="student-sub">Нет данных: ${s.procedureUnknown}</div>` : !s.procedureOverdue && !s.procedureReview ? '<span class="muted">Нет просрочек</span>' : ""}</td></tr>`,
        )
        .join("")
    : '<tr><td colspan="4"><div class="empty"><h3>Студенты не найдены</h3><p>Проверьте фильтры. Нераспределённые студенты находятся во всём реестре.</p></div></td></tr>';
  $("#result-count").textContent = rows.length
    ? `${tablePage * 20 + 1}–${Math.min((tablePage + 1) * 20, rows.length)} из ${rows.length}`
    : "Нет записей";
  $("#prev-page").disabled = tablePage === 0;
  $("#next-page").disabled = (tablePage + 1) * 20 >= rows.length;
  $("#prev-page").onclick = () => {
    tablePage--;
    renderAdminRows();
  };
  $("#next-page").onclick = () => {
    tablePage++;
    renderAdminRows();
  };
  $$("[data-profile]").forEach(
    (b) => (b.onclick = () => safe(() => profile(b.dataset.profile))),
  );
}
async function profile(id) {
  const data = await api("/api/admin/students/" + id),
    s = data.student,
    d = $("#profile");
  const options = (items, value) =>
    items
      .map(
        ([v, l]) =>
          `<option value="${esc(v)}" ${String(value ?? "") === String(v) ? "selected" : ""}>${esc(l)}</option>`,
      )
      .join("");
  d.innerHTML = `<div class="dialog-head"><div><div class="eyebrow">Карточка студента</div><h2>${esc(s.name)}</h2></div><button class="btn small" id="close-profile" aria-label="Закрыть карточку">×</button></div><div class="dialog-body"><p id="student-assignment">${esc(s.manager?.name || "Менеджер не назначен")} · ${esc(s.program || "Программа не указана")} ${s.year ? "· " + s.year + " курс" : ""}</p>${!data.canEdit ? '<div class="notice">Просмотр. Изменения доступны менеджеру программы и курса или руководству.</div>' : ""}
  <details ${!s.program ? "open" : ""}><summary>Контингент и распределение</summary><form id="student-profile" class="profile-form"><fieldset ${user.role !== "admin" ? "disabled" : ""}><label>Программа<select name="program">${options([["", "Не указана"], ...data.programs.map((p) => [p, p])], s.program)}</select></label><label>Курс<select name="year">${options([[0, "Не указан"], ...[1, 2, 3, 4, 5, 6].map((y) => [y, y])], s.year || 0)}</select></label><label>Иностранный контингент<select name="foreignStatus">${options(
    [
      ["unknown", "Не проверено"],
      ["confirmed", "Подтверждён"],
      ["excluded", "Не входит"],
    ],
    s.foreignStatus || "unknown",
  )}</select></label><label>Обучение<select name="enrollmentStatus">${options(
    [
      ["active", "Обучается"],
      ["leave", "Академический отпуск"],
      ["graduated", "Выпускник"],
      ["withdrawn", "Отчислен"],
    ],
    s.enrollmentStatus || "active",
  )}</select></label><label>Гражданство<input name="citizenship" maxlength="100" value="${esc(s.citizenship)}"></label><label>Последний въезд в РФ<input type="date" name="arrivalDate" value="${esc(s.arrivalDate)}"></label><label>Основание пребывания<select name="residence">${options(
    [
      ["", "Не указано"],
      ["visa", "Виза"],
      ["visa_free", "Безвизовый въезд"],
      ["rvp", "РВП"],
      ["rvpo", "РВПО"],
      ["residence_permit", "ВНЖ"],
      ["other", "Другое"],
    ],
    s.residence,
  )}</select></label><button class="btn primary small">Сохранить данные студента</button></fieldset></form></details>
  <h3>Обязательные процедуры</h3><p class="muted">Сроки устанавливает сотрудник после проверки применимости. Отправленные документы ожидают проверки и не считаются подтверждённым нарушением. Подтверждения, направленные через HSE App X, здесь автоматически не появляются.</p>
  ${data.procedures
    .map(
      (p) =>
        `<details class="procedure-item"><summary>${esc(p.title)} <span class="pill ${["overdue", "expired"].includes(p.status) ? "red" : p.status === "confirmed" ? "green" : ""}">${procedureLabels[p.status]}</span></summary><p>${esc(p.hint)} <a href="${esc(p.source)}" target="_blank" rel="noopener">Инструкция ВШЭ ↗</a></p><form data-procedure="${p.id}" class="profile-form"><fieldset ${data.canEdit ? "" : "disabled"}><label>Статус<select name="state">${options(
          ["unknown", "pending", "submitted", "confirmed", "exempt"].map(
            (v) => [v, procedureLabels[v]],
          ),
          p.state,
        )}</select></label><label>Выполнить до<input type="date" name="dueDate" value="${esc(p.dueDate)}"></label><label>Дата выполнения<input type="date" name="completedAt" value="${esc(p.completedAt)}"></label><label>Действительно до<input type="date" name="validUntil" value="${esc(p.validUntil)}"></label><label class="wide">Комментарий / основание освобождения<textarea name="note" maxlength="1000" rows="2">${esc(p.note)}</textarea></label><button class="btn primary small">Сохранить процедуру</button></fieldset></form>${p.updatedAt ? `<small>Обновлено ${fmtDate(p.updatedAt)} · ${esc(p.checkedBy)}</small>` : ""}</details>`,
    )
    .join("")}
  <h3>Посещаемость</h3><p>${s.attendance === null ? "Пока нет отметок" : "Посещение: " + s.attendance + "%"} · Без явки: ${s.days} учебных дней</p>${data.records.length ? data.records.map((r) => `<div class="record"><div>${esc(r.lesson.course)}<small>${fmtDate(r.lesson.date)} · ${r.lesson.start}</small></div><span>${labels[r.status]}</span></div>`).join("") : '<p class="muted">Преподаватели ещё не внесли отметки.</p>'}${data.debts.length ? '<p class="notice">В прежней версии внесены отдельные учебные задолженности. Они сохранены, но не считаются долгами по процедурам.</p>' + data.debts.map((x) => `<p>${esc(x.title)}: ${x.resolved ? "закрыта" : "открыта"}</p>`).join("") : ""}</div>`;
  if (!d.open) d.showModal();
  $("#close-profile").onclick = () => d.close();
  const submit = (form, url, transform = (x) => x) => {
    form.onsubmit = (e) => {
      e.preventDefault();
      const payload = transform(Object.fromEntries(new FormData(form))),
        button = form.querySelector("button");
      button.disabled = true;
      safe(async () => {
        const saved = await api(url, {
          method: "PUT",
          body: JSON.stringify(payload),
        });
        // Сохраняем остальные открытые формы: они могут содержать ещё не отправленные правки.
        if (form.dataset.procedure)
          data.procedures.find((p) => p.id === form.dataset.procedure).version =
            saved.version;
        else s.version = saved.version;
        const fresh = await api("/api/admin/students/" + id);
        if (form.dataset.procedure) {
          const record = fresh.procedures.find(
            (p) => p.id === form.dataset.procedure,
          );
          const badge = form.closest("details").querySelector("summary .pill");
          badge.textContent = procedureLabels[record.status];
          badge.className =
            "pill " +
            (["overdue", "expired"].includes(record.status)
              ? "red"
              : record.status === "confirmed"
                ? "green"
                : "");
        } else {
          const record = fresh.student;
          $("#student-assignment").textContent =
            (record.manager?.name || "Менеджер не назначен") +
            " · " +
            (record.program || "Программа не указана") +
            (record.year ? " · " + record.year + " курс" : "");
        }
        overview = await api("/api/admin/overview");
        adminView();
        toast("Сохранено");
      }).finally(() => {
        if (button.isConnected) button.disabled = false;
      });
    };
  };
  submit(
    $("#student-profile"),
    "/api/admin/students/" + id + "/profile",
    (x) => ({ ...x, year: Number(x.year), version: s.version || 0 }),
  );
  $$("[data-procedure]").forEach((f) =>
    submit(
      f,
      "/api/admin/students/" + id + "/procedures/" + f.dataset.procedure,
      (x) => ({
        ...x,
        version:
          data.procedures.find((p) => p.id === f.dataset.procedure).version ||
          0,
      }),
    ),
  );
}
window.addEventListener("beforeunload", (e) => {
  if (dirty) {
    e.preventDefault();
    e.returnValue = "";
  }
});
try {
  session = await api("/api/session");
  user = session.user;
  if (user) {
    officeScope = user.role === "office" ? "mine" : "all";
    page = user.role !== "teacher" ? "dashboard" : "journal";
    await showApp();
  } else loginView();
} catch (e) {
  root.innerHTML =
    '<div class="error-box">Не удалось открыть журнал. Обновите страницу.</div>';
  toast(e.message, true);
}

function automationView() {
  const a = automation,
    backup = a.backup ? JSON.parse(a.backup.value) : null;
  $("#content").innerHTML =
    `<div class="page-heading"><div><div class="eyebrow">Руководство</div><h1>Автоматический сбор</h1><p>Расписание обновляется на сервере, даже когда никто не открыл сайт.</p></div></div><div class="metrics"><div class="metric"><label>Преподавателей</label><strong>${a.total}</strong></div><div class="metric"><label>Обновлено</label><strong>${a.synced}</strong></div><div class="metric"><label>Ожидают</label><strong>${a.pending}</strong></div><div class="metric alert"><label>Требуют проверки</label><strong>${a.failed}</strong></div></div><div class="panel mini-panel"><h2>${a.enabled ? "Фоновое обновление работает" : "Фоновое обновление отключено"}</h2><p>Интервал: ${a.intervalMinutes} мин. Запросы выполняются по очереди. При ошибке сервер сохраняет предыдущие данные и назначает повтор.</p><div class="quality-row"><span>Почт преподавателей найдено в РУЗ</span><strong>${a.linkedEmails}</strong></div><div class="quality-row"><span>Резервная копия базы</span><strong>${backup ? (backup.ok ? "Создана " : "Ошибка ") + fmtDate(backup.at, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "Ещё не создана"}</strong></div></div><div class="panel mini-panel automation-issues"><h2>Исключения</h2>${a.issues.length ? a.issues.map((j) => `<div class="activity-item"><strong>${esc(j.name)}</strong><p>${esc(j.error)}</p><small>Повтор после: ${fmtDate(new Date(j.nextRun).toISOString(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</small></div>`).join("") : "<p>Ошибок обновления пока нет.</p>"}</div><p class="footer-note">Состав студентов берётся из загруженного реестра. Смена группы и новые студенты требуют обновления реестра. Посещение фиксирует преподаватель.</p>`;
}
let refreshing = false;
setInterval(async () => {
  if (
    !user ||
    document.hidden ||
    refreshing ||
    dirty ||
    savePromise ||
    $("#profile").open ||
    ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName)
  )
    return;
  refreshing = true;
  const viewer = user.id,
    view = page;
  const stillHere = () => user?.id === viewer && page === view;
  try {
    if (user.role !== "teacher") {
      if (page === "automation") {
        automation = await api("/api/admin/automation");
        if (stillHere()) automationView();
      } else {
        overview = await api("/api/admin/overview");
        if (stillHere()) adminView();
      }
    } else {
      // Обновляем выбранный журнал без смены пары и без потери локальных правок.
      const before = editSequence,
        id = selected;
      const list = await api("/api/lessons");
      const detail = id ? await api("/api/lessons/" + id) : null;
      if (
        stillHere() &&
        !dirty &&
        !savePromise &&
        before === editSequence &&
        id === selected
      ) {
        lessons = list.lessons;
        session.syncedAt = list.sync?.at;
        if (detail) {
          current = detail;
          marks = Object.fromEntries(
            detail.marks.map((m) => [
              m.studentId,
              { status: m.status, note: m.note || "" },
            ]),
          );
        }
        journalView();
      }
    }
  } catch (e) {
    if (e.status !== 401)
      toast(
        "Не удалось обновить данные. Следующая попытка через 30 секунд.",
        true,
      );
  } finally {
    refreshing = false;
  }
}, 30000);
