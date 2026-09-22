// Страница «Реестр»: руководство ведёт список преподавателей прямо на сайте.
export async function registryView({ api, esc, toast, ask, admin }) {
  const teachers = await api("/api/admin/teachers");
  const root = document.querySelector("#content");
  const again = () =>
    registryView({ api, esc, toast, ask, admin }).catch((e) =>
      toast(e.message, true),
    );
  root.innerHTML = `<div class="page-heading"><div><div class="eyebrow">Факультет права</div><h1>Сотрудники</h1><p>${admin ? "Добавляйте преподавателей и меняйте их ФИО." : "Добавляйте преподавателей, которых нет в списке."} Дисциплины назначаются в карточке студента.</p></div></div><form class="daily-toolbar panel daily-panel" id="teacher-add"><label>ФИО нового преподавателя<input name="name" required minlength="3" maxlength="150" autocomplete="off"></label><button class="btn primary">+ Добавить преподавателя</button></form><section class="panel daily-panel"><div class="daily-toolbar"><input type="search" id="teacher-search" placeholder="Найти преподавателя" aria-label="Найти преподавателя"><span class="muted">Всего: ${teachers.length}</span></div><div id="teacher-rows"></div><div class="daily-toolbar"><button class="btn" id="teacher-more" hidden>Показать ещё</button><span class="muted" id="teacher-count"></span></div></section>`;
  // Список из сотен преподавателей показывается порциями по 50.
  const PAGE = 50;
  let limit = PAGE;
  const render = () => {
    const q = root
      .querySelector("#teacher-search")
      .value.trim()
      .toLocaleLowerCase("ru")
      .replaceAll("ё", "е");
    const found = teachers.filter((t) =>
      t.name.toLocaleLowerCase("ru").replaceAll("ё", "е").includes(q),
    );
    root.querySelector("#teacher-more").hidden = found.length <= limit;
    root.querySelector("#teacher-count").textContent = found.length
      ? `Показано ${Math.min(limit, found.length)} из ${found.length}`
      : "";
    root.querySelector("#teacher-rows").innerHTML =
      found
        .slice(0, limit)
        .map(
          (t) =>
            `<div class="daily-row" data-teacher="${esc(t.id)}"><span><strong>${esc(t.name)}</strong><br><span class="muted">${t.courses.length ? t.courses.map(esc).join(" · ") : "Нет дисциплин и студентов"}</span></span>${admin ? `<span class="daily-options"><button class="btn small" data-action="rename">Изменить ФИО</button><button class="btn small" data-action="delete" ${t.courses.length ? 'disabled title="Сначала снимите связи со студентами"' : ""}>Удалить</button></span>` : ""}</div>`,
        )
        .join("") || "<p>Преподаватели не найдены</p>";
  };
  root.querySelector("#teacher-search").oninput = () => {
    limit = PAGE;
    render();
  };
  root.querySelector("#teacher-more").onclick = () => {
    limit += PAGE;
    render();
  };
  render();
  root.querySelector("#teacher-rows").onclick = async (e) => {
    const action = e.target.dataset.action,
      id = e.target.closest("[data-teacher]")?.dataset.teacher,
      teacher = teachers.find((t) => t.id === id);
    if (!action || !teacher) return;
    try {
      if (action === "rename") {
        const name = prompt("ФИО преподавателя", teacher.name);
        if (!name || name.trim() === teacher.name) return;
        await api("/api/admin/teachers/" + id, {
          method: "PUT",
          body: JSON.stringify({ name }),
        });
        toast("ФИО изменено");
      } else {
        if (
          !(await ask({
            title: "Удалить преподавателя из реестра?",
            text: `${teacher.name}. Удалить можно только запись без студентов и отметок.`,
            ok: "Удалить",
            danger: true,
          }))
        )
          return;
        await api("/api/admin/teachers/" + id, { method: "DELETE" });
        toast("Преподаватель удалён из реестра");
      }
      await again();
    } catch (err) {
      toast(err.message, true);
    }
  };
  root.querySelector("#teacher-add").onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api("/api/admin/teachers", {
        method: "POST",
        body: JSON.stringify({
          name: new FormData(e.currentTarget).get("name"),
        }),
      });
      toast("Преподаватель добавлен в реестр");
      await again();
    } catch (err) {
      toast(err.message, true);
    }
  };
}
