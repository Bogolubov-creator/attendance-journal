let unsaved = false;
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
  const data = await api("/api/daily?date=" + date);
  const marks = new Map(data.marks.map((m) => [m.studentId, m.status]));
  const root = document.querySelector("#content");
  root.innerHTML = `<div class="page-heading"><div><div class="eyebrow">Преподаватель</div><h1>Кто был на занятии</h1><p>Выберите дату и отметьте студентов из вашего списка.</p></div></div><section class="panel daily-panel"><div class="daily-toolbar"><label>Дата занятия<input id="daily-date" type="date" value="${date}" max="${today()}" required></label><span class="muted">${data.students.length} в вашем списке</span></div><p class="muted">«Был» – видели хотя бы на одном занятии в этот день. Пустая отметка означает «Нет данных».</p><div id="daily-list">${
    data.students.length
      ? data.students
          .map(
            (s) =>
              `<div class="daily-row"><strong>${esc(s.name)}</strong><div class="daily-options" role="group" aria-label="${esc(s.name)}">${[
                ["present", "Был"],
                ["absent", "Не был"],
                ["", "Нет данных"],
              ]
                .map(
                  ([v, l]) =>
                    `<button type="button" class="btn" data-student="${esc(s.id)}" data-status="${v}" aria-pressed="${(marks.get(s.id) || "") === v}">${l}</button>`,
                )
                .join("")}</div></div>`,
          )
          .join("")
      : "<p>В вашем списке пока нет студентов. Обратитесь к руководству для проверки привязки.</p>"
  }</div><div class="daily-toolbar"><button class="btn primary" id="daily-save" disabled>Сохранить</button><span id="daily-state" role="status">${data.marks.length ? "Сохранённые отметки загружены" : "Отметки за эту дату ещё не заполнены"}</span></div></section>`;
  const input = root.querySelector("#daily-date"),
    save = root.querySelector("#daily-save"),
    state = root.querySelector("#daily-state");
  root.querySelectorAll("[data-student]").forEach(
    (b) =>
      (b.onclick = () => {
        marks.set(b.dataset.student, b.dataset.status || null);
        unsaved = true;
        save.disabled = false;
        state.textContent = "Есть несохранённые изменения";
        root
          .querySelectorAll("[data-student]")
          .forEach((x) =>
            x.setAttribute(
              "aria-pressed",
              String((marks.get(x.dataset.student) || "") === x.dataset.status),
            ),
          );
      }),
  );
  input.onchange = async () => {
    if (!input.value || input.value > today()) {
      input.value = date;
      return;
    }
    if (unsaved && !confirm("Перейти к другой дате без сохранения отметок?")) {
      input.value = date;
      return;
    }
    const previous = date;
    date = input.value;
    try {
      await dailyJournal({ api, esc, toast });
      unsaved = false;
    } catch (e) {
      date = previous;
      input.value = date;
      toast(e.message, true);
    }
  };
  save.onclick = async () => {
    root.querySelectorAll("button,input").forEach((x) => (x.disabled = true));
    try {
      const result = await api("/api/daily", {
        method: "PUT",
        body: JSON.stringify({
          date,
          version: data.version,
          marks: data.students.map((s) => ({
            studentId: s.id,
            status: marks.get(s.id) || null,
          })),
        }),
      });
      data.version = result.version;
      unsaved = false;
      state.textContent = "Сохранено. Ответы доступны руководству.";
      toast("Отметки сохранены");
    } catch (e) {
      toast(e.message, true);
      state.textContent = e.message;
    } finally {
      root
        .querySelectorAll("button,input")
        .forEach((x) => (x.disabled = false));
      save.disabled = !unsaved;
    }
  };
}
export async function dailyDashboard({ api, esc, toast }) {
  const data = await api(
    "/api/daily/overview?" + new URLSearchParams({ from, to }),
  );
  const root = document.querySelector("#content");
  const labels = {
    present: "Был хотя бы раз",
    absent: "Присутствие не отмечено",
    unknown: "Нет данных",
  };
  root.innerHTML = `<div class="page-heading"><div><div class="eyebrow">Руководство</div><h1>Кто появлялся на занятиях</h1><p>Достаточно одного подтверждения присутствия от любого преподавателя за выбранный период.</p></div></div><form class="daily-toolbar panel daily-panel" id="period"><label>С даты<input type="date" name="from" value="${from}" max="${today()}" required></label><label>По дату<input type="date" name="to" value="${to}" max="${today()}" required></label><button class="btn primary">Показать</button><a class="btn" href="/api/daily/export?${new URLSearchParams({ from, to })}">Выгрузить для Excel · CSV</a></form><div class="metrics">${["present", "absent", "unknown"].map((status) => `<div class="metric"><label>${labels[status]}</label><strong>${data.students.filter((s) => s.status === status).length}</strong></div>`).join("")}</div><p class="footer-note">«Присутствие не отмечено» – есть только ответы «Не был». Это не подтверждает отсутствие на всех занятиях. «Нет данных» – за период нет ни одного ответа.</p><section class="panel daily-panel"><div class="daily-toolbar"><input type="search" id="daily-search" placeholder="Найти студента" aria-label="Найти студента"><select id="daily-filter" aria-label="Результат"><option value="all">Все студенты</option>${Object.entries(
    labels,
  )
    .map(([v, l]) => `<option value="${v}">${l}</option>`)
    .join(
      "",
    )}</select><button class="btn" id="daily-refresh">Обновить ответы</button></div><div id="daily-results"></div></section>`;
  const render = () => {
    const q = root
        .querySelector("#daily-search")
        .value.trim()
        .toLocaleLowerCase("ru")
        .replaceAll("ё", "е"),
      filter = root.querySelector("#daily-filter").value;
    const rows = data.students.filter(
      (s) =>
        s.name.toLocaleLowerCase("ru").replaceAll("ё", "е").includes(q) &&
        (filter === "all" || s.status === filter),
    );
    root.querySelector("#daily-results").innerHTML =
      rows
        .map(
          (s) =>
            `<details class="daily-person"><summary><strong>${esc(s.name)}</strong><span class="daily-result ${s.status}">${labels[s.status]}</span><span class="muted">Последний раз: ${s.lastVisit || "нет отметок"} · дней за период: ${s.daysPresent}</span></summary><div class="daily-history"><p>Ответы за выбранный период</p>${s.history.length ? s.history.map((r) => `<div class="daily-row"><span>${esc(r.date)} · ${esc(r.teacher)}${r.source === "lesson" ? " · из журнала занятий" : ""}</span><strong>${r.status === "present" ? "Был" : "Не был"}</strong></div>`).join("") : '<p class="muted">Ответов нет</p>'}</div></details>`,
        )
        .join("") || "<p>Студенты не найдены</p>";
  };
  root.querySelector("#daily-search").oninput = render;
  root.querySelector("#daily-filter").onchange = render;
  render();
  root.querySelector("#period").onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget),
      a = f.get("from"),
      b = f.get("to");
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
  root.querySelector("#daily-refresh").onclick = () =>
    dailyDashboard({ api, esc, toast }).catch((e) => toast(e.message, true));
}
