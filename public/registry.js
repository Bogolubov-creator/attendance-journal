// Страница «Реестр»: руководство ведёт список преподавателей прямо на сайте.
export async function registryView({ api, esc, toast }) {
  const teachers = await api("/api/admin/teachers");
  const root = document.querySelector("#content");
  const again = () =>
    registryView({ api, esc, toast }).catch((e) => toast(e.message, true));
  root.innerHTML = `<div class="page-heading"><div><div class="eyebrow">Факультет права</div><h1>Реестр преподавателей</h1><p>Добавляйте преподавателей и меняйте их ФИО. Дисциплины назначаются в карточке студента.</p></div></div><form class="daily-toolbar panel daily-panel" id="teacher-add"><label>ФИО нового преподавателя<input name="name" required minlength="3" maxlength="150" autocomplete="off"></label><button class="btn primary">+ Добавить преподавателя</button></form><section class="panel daily-panel"><div class="daily-toolbar"><input type="search" id="teacher-search" placeholder="Найти преподавателя" aria-label="Найти преподавателя"><span class="muted">Всего: ${teachers.length}</span></div><div id="teacher-rows"></div></section>`;
  const render = () => {
    const q = root
      .querySelector("#teacher-search")
      .value.trim()
      .toLocaleLowerCase("ru")
      .replaceAll("ё", "е");
    root.querySelector("#teacher-rows").innerHTML =
      teachers
        .filter((t) =>
          t.name.toLocaleLowerCase("ru").replaceAll("ё", "е").includes(q),
        )
        .map(
          (t) =>
            `<div class="daily-row" data-teacher="${esc(t.id)}"><span><strong>${esc(t.name)}</strong><br><span class="muted">${t.courses.length ? t.courses.map(esc).join(" · ") : "Нет дисциплин и студентов"}</span></span><span class="daily-options"><button class="btn small" data-action="rename">Изменить ФИО</button><button class="btn small" data-action="delete" ${t.courses.length ? 'disabled title="Сначала снимите связи со студентами"' : ""}>Удалить</button></span></div>`,
        )
        .join("") || "<p>Преподаватели не найдены</p>";
  };
  root.querySelector("#teacher-search").oninput = render;
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
        if (!confirm(`Удалить из реестра: ${teacher.name}?`)) return;
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
