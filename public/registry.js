// Страница «Реестр»: руководство ведёт список преподавателей прямо на сайте.
export async function registryView({
  api,
  esc,
  toast,
  ask,
  plural,
  admin,
  openStudents,
}) {
  const teachers = await api("/api/admin/teachers");
  const root = document.querySelector("#content");
  const again = () =>
    registryView({ api, esc, toast, ask, plural, admin, openStudents }).catch(
      (e) => toast(e.message, true),
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
            `<div class="daily-row" data-teacher="${esc(t.id)}"><span><strong>${esc(t.name)}</strong><br><span class="muted">${t.courses.length ? t.courses.map(esc).join(" · ") : "Нет дисциплин и студентов"}</span>${t.students ? `<br><button type="button" class="button-link" data-action="students">${plural(t.students, ["студент", "студента", "студентов"])} →</button>` : ""}</span>${admin ? `<span class="daily-options"><button class="btn small" data-action="rename">Изменить ФИО</button><button class="btn small" data-action="delete" ${t.courses.length ? 'disabled title="Сначала снимите связи со студентами"' : ""}>Удалить</button></span>` : ""}</div>`,
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
    if (action === "students") return openStudents(teacher);
    if (action === "cancel") return render();
    try {
      if (action === "rename") {
        // ФИО правится прямо в строке.
        const row = e.target.closest("[data-teacher]");
        row.innerHTML = `<form class="rename-row"><input name="name" value="${esc(teacher.name)}" required minlength="3" maxlength="150" autocomplete="off" aria-label="ФИО преподавателя"><button class="btn primary small">Сохранить</button><button type="button" class="btn small" data-action="cancel">Отмена</button></form>`;
        const input = row.querySelector("input");
        input.focus();
        input.select();
        row.querySelector("form").onsubmit = async (ev) => {
          ev.preventDefault();
          const name = input.value.trim();
          if (name === teacher.name) return render();
          try {
            await api("/api/admin/teachers/" + id, {
              method: "PUT",
              body: JSON.stringify({ name }),
            });
            toast("ФИО изменено");
            await again();
          } catch (err) {
            toast(err.message, true);
          }
        };
        return;
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
