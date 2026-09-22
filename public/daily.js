let unsaved = false;
let saving = false;
export const isDailySaving = () => saving;
export const resetDailySession = () => {
  unsaved = false;
  course = null;
  date = today();
};
export const hasDailyChanges = () => unsaved;
export const discardDailyChanges = () => {
  unsaved = false;
};
const today = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
let date = today(),
  course = null,
  from = (() => {
    const d = new Date(today() + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
  })(),
  to = today();
window.addEventListener("beforeunload", (e) => {
  if (unsaved) {
    e.preventDefault();
    e.returnValue = "";
  }
});
export async function dailyJournal({ api, esc, toast }) {
  const data = await api(
    "/api/daily?" +
      new URLSearchParams({ date, ...(course ? { course } : {}) }),
  );
  course = data.course;
  const marks = new Map(data.marks.map((m) => [m.studentId, m.status]));
  const root = document.querySelector("#content");
  root.innerHTML = `<div class="page-heading"><div><div class="eyebrow">Преподаватель</div><h1>Журнал посещаемости</h1><p>Выберите дату и дисциплину, затем отметьте студентов.</p></div><form class="daily-head" id="daily-head"><label>Дата занятия<input id="daily-date" type="date" value="${date}" max="${today()}" required></label><div class="daily-nav" role="group" aria-label="Переход по дням"><button type="button" class="btn small" id="daily-prev">← День назад</button><button type="button" class="btn small" id="daily-today" ${date === today() ? "hidden" : ""}>Сегодня</button><button type="button" class="btn small" id="daily-next" ${date >= today() ? "disabled" : ""}>День вперёд →</button></div><label>Дисциплина<select id="daily-course" ${data.courses.length ? "" : "disabled"}>${data.courses.length ? data.courses.map((c) => `<option value="${esc(c)}" ${c === course ? "selected" : ""}>${esc(c)}</option>`).join("") : "<option>Нет дисциплин</option>"}</select></label></form></div><section class="panel daily-panel"><div class="daily-toolbar"><strong>${esc(course || "")}</strong><span class="muted">${data.students.length} в списке по дисциплине</span><button type="button" class="btn small push-right" id="daily-all-present" ${data.students.length ? "" : "disabled"}>Все присутствовали</button></div><p class="muted">«Присутствовал(а)» – видели на занятии по этой дисциплине в этот день. Пустая отметка означает «Нет данных».</p><div id="daily-list">${
    data.students.length
      ? data.students
          .map(
            (s) =>
              `<div class="daily-row"><strong>${esc(s.name)}</strong><div class="daily-options" role="group" aria-label="${esc(s.name)}">${[
                ["present", "Присутствовал(а)"],
                ["absent", "Отсутствовал(а)"],
                ["", "Нет данных"],
              ]
                .map(
                  ([v, l]) =>
                    `<button type="button" class="btn" data-student="${esc(s.id)}" data-status="${v}" aria-pressed="${(marks.get(s.id) || "") === v}">${l}</button>`,
                )
                .join("")}</div></div>`,
          )
          .join("")
      : `<div class="empty"><h3>${data.courses.length ? "В журнале пока нет студентов" : "У вас пока нет дисциплин в журнале"}</h3><p>Студентов привязывает менеджер учебного офиса в карточке студента: дисциплина, группа, преподаватель. Если студенты должны быть в этом списке, напишите менеджеру своей программы.</p></div>`
  }</div></section><div class="daily-save-bar"><button class="btn primary" id="daily-save" disabled>Сохранить</button><span id="daily-state" role="status">${data.marks.length ? "Сохранённые отметки загружены" : "Отметки за эту дату ещё не заполнены"}</span></div>`;
  const reload = document.createElement("button");
  reload.type = "button";
  reload.className = "btn";
  reload.textContent = "Загрузить сохранённые отметки";
  reload.hidden = true;
  root.querySelector("#daily-state").after(reload);
  reload.onclick = async () => {
    if (
      unsaved &&
      !confirm(
        "Загрузить отметки с сервера? Несохранённые изменения будут потеряны.",
      )
    )
      return;
    try {
      await dailyJournal({ api, esc, toast });
      unsaved = false;
    } catch (e) {
      toast(e.message, true);
    }
  };
  const input = root.querySelector("#daily-date"),
    select = root.querySelector("#daily-course"),
    save = root.querySelector("#daily-save"),
    state = root.querySelector("#daily-state");
  // Число изменённых отметок считается относительно сохранённых на сервере.
  let original = new Map(marks);
  const refresh = () => {
    const changed = data.students.filter(
      (s) => (marks.get(s.id) || "") !== (original.get(s.id) || ""),
    ).length;
    unsaved = changed > 0;
    save.disabled = !unsaved;
    state.textContent = unsaved
      ? `Изменено: ${changed} · не сохранено`
      : original.size
        ? "Сохранённые отметки загружены"
        : "Отметки за эту дату ещё не заполнены";
    root
      .querySelectorAll("[data-student]")
      .forEach((x) =>
        x.setAttribute(
          "aria-pressed",
          String((marks.get(x.dataset.student) || "") === x.dataset.status),
        ),
      );
  };
  root.querySelectorAll("[data-student]").forEach(
    (b) =>
      (b.onclick = () => {
        marks.set(b.dataset.student, b.dataset.status || null);
        refresh();
      }),
  );
  root.querySelector("#daily-all-present").onclick = () => {
    data.students.forEach((s) => marks.set(s.id, "present"));
    refresh();
  };
  const shiftDay = (n) => {
    const d = new Date(date + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  root.querySelector("#daily-prev").onclick = () =>
    switchTo([shiftDay(-1), course]);
  root.querySelector("#daily-next").onclick = () =>
    switchTo([shiftDay(1), course]);
  root.querySelector("#daily-today").onclick = () =>
    switchTo([today(), course]);
  const switchTo = async (next) => {
    if (unsaved && !confirm("Перейти без сохранения отметок?")) {
      input.value = date;
      select.value = course;
      return;
    }
    const previous = [date, course];
    const controls = [...root.querySelectorAll("button,input,select")].map(
      (x) => [x, x.disabled],
    );
    controls.forEach(([x]) => (x.disabled = true));
    [date, course] = next;
    try {
      await dailyJournal({ api, esc, toast });
      unsaved = false;
    } catch (e) {
      [date, course] = previous;
      input.value = date;
      select.value = course;
      toast(e.message, true);
    } finally {
      controls.forEach(([x, disabled]) => (x.disabled = disabled));
    }
  };
  input.onchange = () => {
    if (!input.value || input.value > today()) input.value = date;
    else switchTo([input.value, course]);
  };
  select.onchange = () => switchTo([date, select.value]);
  save.onclick = async () => {
    if (saving) return;
    saving = true;
    state.textContent = "Сохраняем отметки…";
    root
      .querySelectorAll("button,input,select")
      .forEach((x) => (x.disabled = true));
    try {
      const result = await api("/api/daily", {
        method: "PUT",
        body: JSON.stringify({
          date,
          course,
          version: data.version,
          marks: data.students.map((s) => ({
            studentId: s.id,
            status: marks.get(s.id) || null,
          })),
        }),
      });
      data.version = result.version;
      original = new Map(marks);
      unsaved = false;
      state.textContent = "Отметки сохранены.";
      toast("Отметки сохранены");
    } catch (e) {
      toast(e.message, true);
      state.textContent = e.message;
      if (e.status === 409) reload.hidden = false;
    } finally {
      saving = false;
      root
        .querySelectorAll("button,input,select")
        .forEach((x) => (x.disabled = false));
      save.disabled = !unsaved;
      select.disabled = !data.courses.length;
    }
  };
}
// Готовые периоды: текущая неделя с понедельника, текущий месяц, семестр (с 1 сентября или с 1 февраля).
function presetRange(kind) {
  const end = today(),
    d = new Date(end + "T12:00:00Z");
  if (kind === "week") d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  else if (kind === "month") d.setUTCDate(1);
  else {
    const m = d.getUTCMonth();
    if (m >= 8) d.setUTCMonth(8, 1);
    else if (m >= 1) d.setUTCMonth(1, 1);
    else d.setUTCFullYear(d.getUTCFullYear() - 1, 8, 1);
  }
  return [d.toISOString().slice(0, 10), end];
}
export async function dailyDashboard({ api, esc, toast }) {
  const data = await api(
    "/api/daily/overview?" + new URLSearchParams({ from, to }),
  );
  const root = document.querySelector("#content");
  const alerts = data.students.filter((s) => s.absenceAlert);
  const labels = {
    present: "Присутствовал(а) хотя бы раз",
    absent: "Отсутствуют",
    unknown: "Нет данных",
  };
  const ru = (d) => d.split("-").reverse().join(".");
  const period = `с ${ru(from)} по ${ru(to)}`;
  const notes = {
    present: `За период ${period}`,
    absent: `За период ${period}; дни без явки – на сегодня`,
    unknown: `Нет отметок за период ${period}`,
  };
  root.innerHTML = `<div class="page-heading"><div><div class="eyebrow">Факультет права</div><h1>Посещаемость за период</h1><p>Сводка по отметкам преподавателей за период ${period}.</p></div></div><form class="daily-toolbar panel daily-panel" id="period"><label>С даты<input type="date" name="from" value="${from}" max="${today()}" required></label><label>По дату<input type="date" name="to" value="${to}" max="${today()}" required></label><div class="period-presets" role="group" aria-label="Готовые периоды">${[
    ["week", "Неделя"],
    ["month", "Месяц"],
    ["semester", "Семестр"],
  ]
    .map(
      ([k, l]) =>
        `<button type="button" class="btn small" data-preset="${k}" aria-pressed="${presetRange(k)[0] === from && presetRange(k)[1] === to}">${l}</button>`,
    )
    .join(
      "",
    )}</div><a class="btn" href="/api/daily/export?${new URLSearchParams({ from, to })}">Выгрузить для Excel · CSV</a></form><section class="panel absence-notice ${alerts.length ? "has-alerts" : ""}" aria-label="Тревоги посещаемости"><div><h2>Тревоги на сегодня: ${alerts.length}</h2><p>Больше 7 учебных дней без посещения. Считаются только даты с отметкой «Отсутствовал(а)» после последней явки, независимо от выбранного периода.</p></div><button class="btn ${alerts.length ? "primary" : ""}" id="show-absence-alerts" ${alerts.length ? "" : "disabled"}>Показать тревоги</button></section><div class="metrics">${["present", "absent", "unknown"].map((status) => `<button type="button" class="metric metric-filter" data-status="${status}" aria-pressed="false"><label>${labels[status]}</label><strong>${data.students.filter((s) => s.status === status).length}</strong><small>${notes[status]}</small></button>`).join("")}</div><p class="footer-note">«Отсутствуют» – за выбранный период есть только отметки «Отсутствовал(а)»; рядом указано, сколько учебных дней подряд без явки на сегодня. Это не подтверждает отсутствие на всех занятиях. «Нет данных» – за период нет ни одной отметки.</p><section class="panel daily-panel"><div class="daily-toolbar"><input type="search" id="daily-search" placeholder="Найти студента" aria-label="Найти студента"><select id="daily-filter" aria-label="Результат"><option value="all">Все студенты</option><option value="alert">Тревога: больше 7 учебных дней</option><option value="absent4">Не были более 4 дней</option>${Object.entries(
    labels,
  )
    .map(([v, l]) => `<option value="${v}">${l}</option>`)
    .join(
      "",
    )}</select><button class="btn" id="daily-refresh">Обновить отметки</button></div><div id="daily-results"></div></section>`;
  const render = () => {
    const q = root
        .querySelector("#daily-search")
        .value.trim()
        .toLocaleLowerCase("ru")
        .replaceAll("ё", "е"),
      filter = root.querySelector("#daily-filter").value;
    root
      .querySelectorAll(".metric-filter")
      .forEach((m) =>
        m.setAttribute("aria-pressed", String(m.dataset.status === filter)),
      );
    const rows = data.students.filter(
      (s) =>
        s.name.toLocaleLowerCase("ru").replaceAll("ё", "е").includes(q) &&
        (filter === "all" ||
          (filter === "alert"
            ? s.absenceAlert
            : filter === "absent4"
              ? s.absenceDays > 4
              : s.status === filter)),
    );
    root.querySelector("#daily-results").innerHTML =
      rows
        .map(
          (s) =>
            `<details class="daily-person ${s.absenceAlert ? "has-alert" : ""}"><summary><strong>${esc(s.name)}</strong>${s.absenceAlert ? `<span class="pill red">Тревога · ${s.absenceDays} уч. дней без явки</span>` : ""}<span class="daily-result ${s.status}">${labels[s.status]}${s.status === "absent" ? ` · ${s.absenceDays} уч. дн.` : ""}</span><span class="muted">Последний раз: ${s.lastVisit || "нет отметок"} · дней за период: ${s.daysPresent}</span></summary><div class="daily-history"><p>Отметки преподавателей за период ${period}</p>${s.history.length ? s.history.map((r) => `<div class="daily-row"><span>${esc(r.date)} · ${esc(r.teacher)}${r.course ? " · " + esc(r.course) : ""}${r.source === "lesson" ? " · из журнала занятий" : ""}</span><strong>${r.status === "present" ? "Присутствовал(а)" : "Отсутствовал(а)"}</strong></div>`).join("") : '<p class="muted">Отметок за период нет</p>'}</div></details>`,
        )
        .join("") || "<p>Студенты не найдены</p>";
  };
  root.querySelector("#daily-search").oninput = render;
  root.querySelector("#daily-filter").onchange = render;
  // Метрика – тоже фильтр: щелчок показывает студентов с этим статусом, повторный снимает.
  root.querySelectorAll(".metric-filter").forEach(
    (m) =>
      (m.onclick = () => {
        const select = root.querySelector("#daily-filter");
        select.value =
          select.value === m.dataset.status ? "all" : m.dataset.status;
        render();
      }),
  );
  render();
  root.querySelector("#show-absence-alerts").onclick = () => {
    root.querySelector("#daily-search").value = "";
    root.querySelector("#daily-filter").value = "alert";
    render();
    root.querySelector("#daily-results").scrollIntoView({ block: "nearest" });
  };
  const periodForm = root.querySelector("#period");
  const applyPeriod = async (a, b) => {
    if (!a || !b) return;
    if (a > b) {
      toast("Проверьте порядок дат", true);
      return;
    }
    const old = [from, to];
    from = a;
    to = b;
    try {
      await dailyDashboard({ api, esc, toast });
    } catch (e) {
      [from, to] = old;
      toast(e.message, true);
    }
  };
  // Период применяется сразу: по смене даты или по готовому периоду, без отдельной кнопки.
  periodForm.onsubmit = (e) => {
    e.preventDefault();
    const f = new FormData(periodForm);
    applyPeriod(f.get("from"), f.get("to"));
  };
  periodForm
    .querySelectorAll("input")
    .forEach((i) => (i.onchange = () => periodForm.requestSubmit()));
  periodForm
    .querySelectorAll("[data-preset]")
    .forEach(
      (b) => (b.onclick = () => applyPeriod(...presetRange(b.dataset.preset))),
    );
  root.querySelector("#daily-refresh").onclick = () =>
    dailyDashboard({ api, esc, toast }).catch((e) => toast(e.message, true));
}
