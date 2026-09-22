import {
  dailyJournal,
  dailyDashboard,
  hasDailyChanges,
  discardDailyChanges,
  resetDailySession,
  isDailySaving,
} from "./daily.js";
import { registryView } from "./registry.js";
const $ = (s) => document.querySelector(s),
  root = $("#app");
const roleLabel = (role) =>
  role === "admin"
    ? "Полный доступ"
    : role === "office"
      ? "Менеджер"
      : "Преподаватель";
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const labels = { present: "Присутствовал(а)", absent: "Отсутствовал(а)" };
let session,
  user,
  page = "journal",
  overview,
  filter = "all",
  query = "",
  toastTimer,
  tablePage = 0;
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
      resetDailySession();
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
  '<div class="brand" aria-label="Факультет права – учебный журнал"><img class="brand-icon" src="./assets/hse-logo.svg" alt="НИУ ВШЭ" width="48" height="48"><span class="brand-name">Факультет<br>права<small>Учебный журнал</small></span></div>';
const search = (id, placeholder, value = "") =>
  `<div class="search"><input id="${id}" type="search" placeholder="${placeholder}" aria-label="${placeholder}" value="${esc(value)}"></div>`;
function loginView() {
  root.innerHTML = `<div class="login"><section class="login-art">${brand}<div><h2 class="login-title">Журнал<br>посещаемости</h2><p>Факультет права НИУ ВШЭ</p></div><small>Посещаемость · Студенты · Документы</small></section><section class="login-main"><div class="login-box"><div class="eyebrow">Факультет права</div><h1>Вход в журнал</h1>${session.selection ? `<form id="select-login" class="access-form"><label for="login-role">Роль</label><select id="login-role"><option value="teacher">Преподаватель</option><option value="office">Менеджер</option><option value="admin">Полный доступ</option></select><label for="person-search">Поиск сотрудника</label><input id="person-search" type="search" placeholder="Начните вводить фамилию"><label for="login-person">Сотрудник</label><select id="login-person" required></select><label for="management-password">Пароль</label><input id="management-password" type="password" autocomplete="current-password" maxlength="256" required><p id="person-scope" class="muted" aria-live="polite"></p><button class="btn primary">Открыть кабинет →</button></form><div class="login-footer">Вход по имени и паролю.${session.demo ? " Локальный просмотр: отметки сохраняются в тестовой базе." : ""}</div>` : '<a class="btn primary" href="/auth/login">Войти</a>'}</div></section></div>`;
  if (!session.selection) return;
  const updateSelection = (hint = "Выберите сотрудника из списка.") => {
    const personId = $("#login-person").value;
    const person = [...session.teachers, ...session.managers].find(
      (p) => p.id === personId,
    );
    const m = session.managers.find(
      (p) => p.id === personId && p.role === "office",
    );
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
        ? ""
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
            password: $("#management-password").value,
          }),
        });
        user = r.user;
        resetDailySession();
        officeScope = "all";
        officeProgram = "";
        officeYear = "";
        page = user.role === "teacher" ? "journal" : "dashboard";
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
  root.innerHTML = `<div class="layout"><aside class="sidebar">${brand}<div class="section-label">${roleLabel(user.role)}</div><nav class="nav" aria-label="Основная навигация">${user.role !== "teacher" ? `<button data-page="dashboard" class="${page === "dashboard" ? "active" : ""}"><span class="nav-icon">▦</span>Обзор</button><button data-page="students" class="${page === "students" ? "active" : ""}"><span class="nav-icon">♙</span>Студенты</button>${user.role === "admin" ? `<button data-page="registry" class="${page === "registry" ? "active" : ""}"><span class="nav-icon">☰</span>Сотрудники</button>` : ""}` : `<button data-page="journal" class="active"><span class="nav-icon">▤</span>Мой журнал</button>`}</nav><div class="side-bottom"><div class="side-note">${user.role !== "teacher" ? "Посещаемость и документы студентов." : "Выберите дату, отметьте студентов и нажмите «Сохранить»."}</div><div class="identity"><span class="avatar">${initials(user.name)}</span><div><strong>${esc(user.name.split(" ").slice(0, 2).join(" "))}</strong><small>${roleLabel(user.role)}</small></div></div><button id="logout" class="logout">Выйти ↗</button></div></aside><main class="main"><header class="topbar"><span class="crumb">Учебный процесс <b>/ ${user.role !== "teacher" ? "Студенты" : "Посещаемость"}</b></span>${session.demo ? '<span class="demo-tag">Локальный просмотр · тестовые отметки</span>' : ""}</header><div class="content" id="content"></div></main></div>`;
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
      if (isDailySaving()) {
        toast("Дождитесь сохранения отметок");
        return;
      }
      if (hasDailyChanges() && !confirm("Выйти без сохранения отметок?"))
        return;
      discardDailyChanges();
      await api("/api/logout", { method: "POST" });
      user = null;
      resetDailySession();
      session = await api("/api/session");
      loginView();
    });
}
const $$ = (s) => [...document.querySelectorAll(s)];
async function showApp() {
  if (isDailySaving()) {
    toast("Дождитесь сохранения отметок");
    return;
  }
  if (hasDailyChanges() && !confirm("Перейти без сохранения отметок?")) return;
  discardDailyChanges();
  shell();
  $("#content").innerHTML = '<div class="loading">Загружаем данные…</div>';
  if (user.role === "teacher") return dailyJournal({ api, esc, toast });
  if (page === "registry") return registryView({ api, esc, toast });
  if (page !== "students") return dailyDashboard({ api, esc, toast });
  overview = await api("/api/admin/overview");
  adminView();
}
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
    `<div class="page-heading"><div><div class="eyebrow">Факультет права</div><h1>${page === "dashboard" ? "Иностранные студенты" : "Реестр иностранных студентов"}</h1><p>${user.role === "admin" ? "Общая статистика факультета. Работа со студентами – по программам и курсам." : "Студенты ваших программ и курсов."}</p></div><div class="heading-actions">${user.role === "admin" ? '<button class="btn primary" id="add-student-open">+ Добавить студента</button>' : ""}<a class="btn" href="/api/admin/export">↓ Выгрузить CSV</a></div></div>
  <div class="metrics"><div class="metric"><label>Иностранные студенты</label><strong>${faculty.length}</strong><small>Подтверждённые, обучаются сейчас</small></div><div class="metric alert"><label>Больше 7 дней без явки</label><strong>${attention.length}</strong><small>По отметкам преподавателей</small></div><div class="metric alert"><label>Просрочены процедуры</label><strong>${overdue.length}</strong><small>Студентов с просроченными документами</small></div><div class="metric"><label>Нет данных о процедурах</label><strong>${faculty.filter((s) => s.procedureUnknown).length}</strong></div></div>
  ${overview.faculty.unverified ? `<div class="notice">Полнота реестра ещё не подтверждена. Загружено ${students.length} студентов; иностранный статус не проверен у ${overview.faculty.unverified}. Они видны в реестре, но не включены в статистику иностранцев. Программы и курсы заполняет руководство.</div>` : ""}
  ${page === "dashboard" ? `<div class="attention-grid">${list("Не посещают занятия", attention, "absence")}${list("Должники по процедурам", overdue, "procedure")}</div>` : ""}
  <div class="admin-columns"><div class="panel"><div class="panel-heading"><div><h2>Список студентов</h2><small>${user.role === "admin" ? "Статистика сверху всегда по факультету, фильтры действуют на таблицу" : "Статистика сверху по вашему участку, фильтры действуют на таблицу"}</small></div>${search("admin-search", "Поиск по ФИО", query)}</div>
  <div class="office-filters">${user.role === "admin" ? '<label>Ответственность<select id="office-scope"><option value="all">Весь факультет</option><option value="mine">Мои программы и курсы</option><option value="unassigned">Не распределены</option></select></label>' : ""}<label>Программа<select id="office-program"><option value="">Все программы</option>${programs.map((p) => `<option>${esc(p)}</option>`).join("")}</select></label><label>Курс<select id="office-year"><option value="">Все курсы</option>${[1, 2, 3, 4, 5, 6].map((y) => `<option>${y}</option>`).join("")}</select></label></div>
  <div class="filter-tabs">${[
    ["all", "Весь реестр"],
    ["foreign", "Подтверждённые иностранцы"],
    ["attention", "Больше 7 дней без явки"],
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
  <details class="filter-legend"><summary>Что означают фильтры</summary><dl><dt>Подтверждённые иностранцы</dt><dd>Студенты с подтверждённым иностранным статусом, которые обучаются сейчас. Только они входят в статистику сверху и в четыре следующих фильтра.</dd><dt>Больше 7 дней без явки</dt><dd>Больше 7 учебных дней с отметкой «Отсутствовал(а)» после последней явки. Считаются только дни, отмеченные преподавателями.</dd><dt>Просрочены процедуры</dt><dd>Хотя бы одна из процедур в карточке просрочена: миграционный учёт, виза и срок пребывания, медицинское освидетельствование, дактилоскопия и фотографирование, медицинское страхование. Просрочена процедура в работе, у которой прошёл назначенный срок, либо подтверждённая процедура, у которой истёк срок действия. Процедуры без данных, освобождённые и сданные на проверку просроченными не считаются.</dd><dt>Обе проблемы</dt><dd>Одновременно тревога по посещаемости и хотя бы одна просроченная процедура – пересечение двух предыдущих фильтров.</dd><dt>На проверке</dt><dd>Хотя бы одна процедура сдана на проверку и ждёт подтверждения.</dd><dt>Нет данных о процедурах</dt><dd>Хотя бы одна процедура в карточке не заполнена.</dd><dt>Статус не проверен</dt><dd>Иностранный статус в карточке ещё не подтверждён. В статистику иностранцев такие студенты не входят.</dd><dt>Нет отметок</dt><dd>Преподаватели ещё не ставили этому студенту ни одной отметки.</dd></dl></details>
  <div class="table-scroll"><table class="admin-table"><thead><tr><th>Студент / менеджер</th><th>Посещение</th><th>Без явки</th><th>Процедуры</th></tr></thead><tbody id="admin-rows"></tbody></table></div><div class="pagination"><small id="result-count"></small><div class="actions"><button class="btn small" id="prev-page" aria-label="Предыдущая страница">←</button><button class="btn small" id="next-page" aria-label="Следующая страница">→</button></div></div></div>
  <aside class="admin-aside"><section class="panel mini-panel"><h3>Ваш участок</h3><p>${user.role === "admin" ? "Весь факультет" : esc(user.scopes?.map((s) => s.program + (s.year ? ", " + s.year + " курс" : "")).join(" · ") || "Весь факультет")}</p><a href="https://pravo.hse.ru/centre/contact" target="_blank" rel="noopener">Распределение менеджеров ↗</a><p>Распределение в журнале обновлено 21.09.2026.</p></section><section class="panel mini-panel"><h3>Полнота данных</h3><div class="quality-row"><span>Без менеджера</span><strong>${overview.faculty.unassigned}</strong></div><div class="quality-row"><span>Студентов с отметками</span><strong>${overview.students.filter((s) => s.marked).length} / ${overview.students.length}</strong></div><div class="quality-row"><span>Резервная копия базы</span><strong>${overview.backup ? (JSON.parse(overview.backup.value).ok ? "Создана " : "Ошибка ") + fmtDate(JSON.parse(overview.backup.value).at, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "Не включена"}</strong></div><p>Нет отметки – не значит отсутствовал. Несколько пропусков за день считаются одним учебным днём.</p></section><section class="panel mini-panel"><h3>Сопровождение иностранцев</h3><p>Применимость процедур проверяется индивидуально: гражданство, основание пребывания, дата въезда и действующие подтверждения.</p><a href="https://ivisa.hse.ru/" target="_blank" rel="noopener">Визовая поддержка ↗</a><p><a href="https://istudents.hse.ru/" target="_blank" rel="noopener">Сервисы и инструкции для иностранцев ↗</a></p><p>Поддержка: istudents.support@hse.ru</p><p>Электронный пропуск, связь и адаптация – сервисные вопросы, они не создают долг по обязательной процедуре.</p></section></aside></div>`;
  if ($("#add-student-open"))
    $("#add-student-open").onclick = () => safe(addStudentDialog);
  if ($("#office-scope")) {
    $("#office-scope").value = officeScope;
    $("#office-scope").onchange = (e) => {
      officeScope = e.target.value;
      tablePage = 0;
      renderAdminRows();
    };
  }
  $("#office-program").value = officeProgram;
  $("#office-year").value = officeYear;
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
            `<tr><td><button class="student-link" data-profile="${s.id}">${esc(s.name)}</button><div class="student-sub">${esc(s.program || "Программа не указана")}${s.year ? " · " + s.year + " курс" : ""}<br>${esc(s.manager?.name || "Менеджер не назначен")}<br>${s.foreignStatus === "confirmed" ? "Иностранный статус подтверждён" : s.foreignStatus === "excluded" ? "Не входит в иностранный контингент" : "Иностранный статус не проверен"}</div></td><td>${s.attendance === null ? '<span class="muted">Нет отметок</span>' : s.attendance + "%"}${s.records.length ? `<br><button class="student-link records-toggle" data-records="${s.id}" aria-expanded="false">Занятия: ${s.records.length}</button>` : ""}</td><td><span class="pill ${s.absenceAlert ? "red" : ""}">${s.days} уч. дн.</span></td><td>${s.procedureOverdue ? `<span class="pill red">Просрочено: ${s.procedureOverdue}</span>` : ""}${s.procedureReview ? `<div class="student-sub">На проверке: ${s.procedureReview}</div>` : ""}${s.procedureUnknown ? `<div class="student-sub">Нет данных: ${s.procedureUnknown}</div>` : !s.procedureOverdue && !s.procedureReview ? '<span class="muted">Нет просрочек</span>' : ""}</td></tr>${s.records.length ? `<tr class="records-row" id="records-${s.id}" hidden><td colspan="4">${s.records.map((r) => `<div class="record"><div>${esc(r.course || "Без дисциплины")}<small>${fmtDate(r.date)} · ${esc(r.teacher || "Преподаватель")}</small></div><span class="pill ${r.status === "present" ? "green" : "red"}">${labels[r.status]}</span></div>`).join("")}</td></tr>` : ""}`,
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
  $$("[data-records]").forEach(
    (b) =>
      (b.onclick = () => {
        const row = document.getElementById("records-" + b.dataset.records);
        row.hidden = !row.hidden;
        b.setAttribute("aria-expanded", String(!row.hidden));
      }),
  );
}
// Руководство добавляет студента, которого нет в импортированном реестре, и привязывает его к преподавателям.
async function addStudentDialog() {
  const [teachers, directory] = await Promise.all([
    api("/api/admin/teachers"),
    api("/api/admin/directory"),
  ]);
  const d = $("#add-student"),
    byName = new Map(teachers.map((t) => [t.name, t]));
  const option = (v, l, selected = false) =>
    `<option value="${esc(v)}" ${selected ? "selected" : ""}>${esc(l)}</option>`;
  d.innerHTML = `<div class="dialog-head"><div><div class="eyebrow">Реестр</div><h2>Добавить иностранного студента</h2></div><button class="btn small" id="add-student-close" aria-label="Закрыть">×</button></div><div class="dialog-body"><form id="add-student-form" class="profile-form"><fieldset><label class="wide">ФИО студента<input name="name" required minlength="3" maxlength="150" autocomplete="off"></label><label>Программа<select name="program">${option("", "Не указана")}${directory.programs.map((p) => option(p, p)).join("")}</select></label><label>Курс<select name="year">${option(0, "Не указан")}${[1, 2, 3, 4, 5, 6].map((y) => option(y, y)).join("")}</select></label><label>Иностранный контингент<select name="foreignStatus">${option("confirmed", "Подтверждён", true)}${option("unknown", "Не проверено")}${option("excluded", "Не входит")}</select></label><label>Гражданство<input name="citizenship" maxlength="100"></label></fieldset><h3>Преподаватели и дисциплины</h3><p class="muted">Студент появится в дневном журнале каждого указанного преподавателя по этой дисциплине.</p><datalist id="teacher-names">${teachers.map((t) => `<option value="${esc(t.name)}"></option>`).join("")}</datalist><div id="link-rows"></div><div class="daily-toolbar"><button type="button" class="btn small" id="link-add">+ Ещё преподаватель</button></div><div class="daily-toolbar"><button class="btn primary">Добавить в реестр</button><span class="muted">Остальные данные заполняются в карточке.</span></div></form></div>`;
  const rows = d.querySelector("#link-rows");
  let counter = 0;
  const addRow = () => {
    const n = counter++;
    const row = document.createElement("div");
    row.className = "link-row";
    row.innerHTML = `<input class="link-teacher" list="teacher-names" placeholder="Преподаватель: начните вводить фамилию" required autocomplete="off"><input class="link-course" list="link-courses-${n}" placeholder="Дисциплина" required maxlength="200" autocomplete="off"><datalist id="link-courses-${n}"></datalist><button type="button" class="btn small" aria-label="Убрать строку">×</button>`;
    row.querySelector(".link-teacher").oninput = (e) => {
      const t = byName.get(e.target.value.trim());
      row.querySelector("datalist").innerHTML = (t?.courses || [])
        .map((c) => `<option value="${esc(c)}"></option>`)
        .join("");
    };
    row.querySelector("button").onclick = () => {
      if (rows.children.length > 1) row.remove();
    };
    rows.append(row);
  };
  addRow();
  d.querySelector("#link-add").onclick = addRow;
  d.querySelector("#add-student-close").onclick = () => d.close();
  if (!d.open) d.showModal();
  d.querySelector("#add-student-form").onsubmit = (e) => {
    e.preventDefault();
    const form = e.currentTarget,
      values = Object.fromEntries(new FormData(form));
    const links = [...rows.querySelectorAll(".link-row")].map((row) => ({
      teacher: row.querySelector(".link-teacher").value.trim(),
      course: row.querySelector(".link-course").value.trim(),
    }));
    const missing = links.find((l) => !byName.has(l.teacher));
    if (missing) {
      toast(`Преподаватель «${missing.teacher}» не найден в реестре`, true);
      return;
    }
    const button = form.querySelector("button.primary");
    button.disabled = true;
    safe(async () => {
      const r = await api("/api/admin/students", {
        method: "POST",
        body: JSON.stringify({
          name: values.name,
          program: values.program,
          year: Number(values.year),
          foreignStatus: values.foreignStatus,
          citizenship: values.citizenship,
          links: links.map((l) => ({
            teacherId: byName.get(l.teacher).id,
            course: l.course,
          })),
        }),
      });
      d.close();
      overview = await api("/api/admin/overview");
      adminView();
      toast("Студент добавлен в реестр");
      await profile(r.id);
    }).finally(() => {
      if (button.isConnected) button.disabled = false;
    });
  };
}
async function profile(id) {
  const data = await api("/api/admin/students/" + id),
    s = data.student,
    d = $("#profile"),
    teachers = user.role === "admin" ? await api("/api/admin/teachers") : [];
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
  )}</select></label><label>Находится в РФ<select name="inRussia">${options(
    [
      ["", "Не указано"],
      ["yes", "Да"],
      ["no", "Нет"],
    ],
    s.inRussia,
  )}</select></label><label>Проживание<select name="housing">${options(
    [
      ["", "Не указано"],
      ["dormitory", "Общежитие"],
      ["private", "Частный адрес"],
    ],
    s.housing,
  )}</select></label><label>Куратор по миграционному учёту<input name="curator" maxlength="200" value="${esc(s.curator)}"></label><label>Паспорт действителен до<input type="date" name="passportUntil" value="${esc(s.passportUntil)}"></label><label>Миграционная карта до<input type="date" name="migrationCardUntil" value="${esc(s.migrationCardUntil)}"></label><label>ФИО латиницей<input name="nameLatin" maxlength="200" value="${esc(s.nameLatin)}"></label><label>Страна, направившая на обучение<input name="sendingCountry" maxlength="200" value="${esc(s.sendingCountry)}"></label><label class="wide">Версия образовательной программы<input name="programVersion" maxlength="200" value="${esc(s.programVersion)}"></label><button class="btn primary small">Сохранить данные студента</button></fieldset></form></details>
  ${user.role === "admin" ? `<details id="registry-block"><summary>Реестр: ФИО, преподаватели и дисциплины</summary><form id="student-rename" class="profile-form"><fieldset><label class="wide">ФИО студента<input name="name" required minlength="3" maxlength="150" autocomplete="off" value="${esc(s.name)}"></label><button class="btn primary small">Сохранить ФИО</button></fieldset></form><div id="student-links">${data.links.map((l, i) => `<div class="record"><div>${esc(l.course)}<small>${esc(l.teacher)}</small></div><button class="btn small" data-unlink="${i}" aria-label="Убрать связь">×</button></div>`).join("") || '<p class="muted">Студент не привязан ни к одному преподавателю и не виден в журналах.</p>'}</div><datalist id="profile-teachers">${teachers.map((t) => `<option value="${esc(t.name)}"></option>`).join("")}</datalist><datalist id="profile-courses"></datalist><form id="student-link" class="link-row"><input name="teacher" list="profile-teachers" placeholder="Преподаватель: начните вводить фамилию" required autocomplete="off"><input name="course" list="profile-courses" placeholder="Дисциплина" required maxlength="200" autocomplete="off"><button class="btn small">+ Связь</button></form><p><button type="button" class="btn small" id="student-delete">Удалить студента из реестра</button> <span class="muted">Только для ошибочных записей без отметок. Отчисленным меняйте статус обучения.</span></p></details>` : ""}
  <h3>Обязательные процедуры</h3><p class="muted">Сроки устанавливает сотрудник после проверки применимости. Отправленные документы ожидают проверки и не считаются подтверждённым нарушением.</p>
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
  <h3>Посещаемость</h3><p>${s.attendance === null ? "Пока нет отметок" : "Посещение: " + s.attendance + "%"} · Без явки: ${s.days} учебных дней</p>${data.records.length ? data.records.map((r) => `<div class="record"><div>${esc(r.course || "Без дисциплины")}<small>${fmtDate(r.date)} · ${esc(r.teacher || "Преподаватель")}</small></div><span>${labels[r.status]}</span></div>`).join("") : '<p class="muted">Преподаватели ещё не внесли отметки.</p>'}${data.debts.length ? '<p class="notice">В прежней версии внесены отдельные учебные задолженности. Они сохранены, но не считаются долгами по процедурам.</p>' + data.debts.map((x) => `<p>${esc(x.title)}: ${x.resolved ? "закрыта" : "открыта"}</p>`).join("") : ""}</div>`;
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
  if (user.role === "admin") {
    // После правки реестра карточка перечитывается; блок остаётся раскрытым.
    const registry = (action, done) =>
      safe(async () => {
        await action();
        toast(done);
        await profile(id);
        $("#registry-block").open = true;
      });
    const link = (method, body) =>
      api("/api/admin/enrollments", { method, body: JSON.stringify(body) });
    $("#student-rename").onsubmit = (e) => {
      e.preventDefault();
      const name = new FormData(e.currentTarget).get("name");
      registry(async () => {
        await api("/api/admin/students/" + id, {
          method: "PUT",
          body: JSON.stringify({ name }),
        });
        overview = await api("/api/admin/overview");
        adminView();
      }, "ФИО изменено");
    };
    $$("[data-unlink]").forEach(
      (b) =>
        (b.onclick = () => {
          const l = data.links[b.dataset.unlink];
          if (confirm(`Убрать связь: ${l.teacher} – ${l.course}?`))
            registry(
              () =>
                link("DELETE", {
                  studentId: id,
                  teacherId: l.teacherId,
                  course: l.course,
                }),
              "Связь убрана",
            );
        }),
    );
    const linkForm = $("#student-link");
    linkForm.elements.teacher.oninput = (e) => {
      const t = teachers.find((t) => t.name === e.target.value.trim());
      $("#profile-courses").innerHTML = (t?.courses || [])
        .map((c) => `<option value="${esc(c)}"></option>`)
        .join("");
    };
    linkForm.onsubmit = (e) => {
      e.preventDefault();
      const f = new FormData(linkForm),
        t = teachers.find((t) => t.name === f.get("teacher").trim());
      if (!t) return toast("Преподаватель не найден в реестре", true);
      registry(
        () =>
          link("POST", {
            studentId: id,
            teacherId: t.id,
            course: f.get("course"),
          }),
        "Связь добавлена",
      );
    };
    $("#student-delete").onclick = () => {
      if (confirm(`Удалить из реестра: ${s.name}?`))
        safe(async () => {
          await api("/api/admin/students/" + id, { method: "DELETE" });
          d.close();
          overview = await api("/api/admin/overview");
          adminView();
          toast("Студент удалён из реестра");
        });
    };
  }
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
try {
  session = await api("/api/session");
  user = session.user;
  if (user) {
    officeScope = "all";
    page = user.role !== "teacher" ? "dashboard" : "journal";
    await showApp();
  } else loginView();
} catch (e) {
  root.innerHTML =
    '<div class="error-box">Не удалось открыть журнал. Обновите страницу.</div>';
  toast(e.message, true);
}

let refreshing = false;
setInterval(async () => {
  if (
    !user ||
    user.role === "teacher" ||
    page === "dashboard" ||
    page === "registry" ||
    document.hidden ||
    refreshing ||
    $("#profile").open ||
    ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName)
  )
    return;
  refreshing = true;
  const viewer = user.id,
    view = page;
  const stillHere = () => user?.id === viewer && page === view;
  try {
    overview = await api("/api/admin/overview");
    if (stillHere()) adminView();
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
