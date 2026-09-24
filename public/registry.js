// Страница «Реестр»: руководство ведёт список преподавателей прямо на сайте.
import {
  accessLabel,
  showInvite,
  exportInvites,
  enablePersonalOnly,
} from "./access.js";
export async function registryView({
  api,
  esc,
  toast,
  ask,
  plural,
  fmtDate,
  silentOnly = false,
  admin,
  openStudents,
}) {
  const [teachers, staffAccess, mode] = await Promise.all([
    api("/api/admin/teachers"),
    admin ? api("/api/admin/staff-access") : [],
    admin ? api("/api/admin/personal-only") : null,
  ]);
  let noAccessOnly = false;
  const withoutAccess = (t) => t.access.state !== "active";
  const accessButton = (p) =>
    `<button class="btn small" data-action="access">${p.access.state === "active" ? "Сбросить пароль" : "Выдать доступ"}</button>`;
  const accessLine = (p) =>
    `<span class="${p.access.state === "none" ? "pill red" : "muted"}">Доступ: ${esc(accessLabel(p.access))}${p.access.login ? " · " + esc(p.access.login) : ""}</span>`;
  const root = document.querySelector("#content");
  const again = () =>
    registryView({
      api,
      esc,
      toast,
      ask,
      plural,
      fmtDate,
      silentOnly,
      admin,
      openStudents,
    }).catch((e) => toast(e.message, true));
  // «Молчит» – ведёт студентов, но за последние 7 дней не поставил ни одной отметки.
  const weekAgo = (() => {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    return d.toISOString().slice(0, 10);
  })();
  const silent = (t) => t.students > 0 && (!t.lastMark || t.lastMark < weekAgo);
  root.innerHTML = `<div class="page-heading"><div><div class="eyebrow">Факультет права</div><h1>Сотрудники</h1><p>${admin ? "Добавляйте преподавателей и меняйте их ФИО." : "Добавляйте преподавателей, которых нет в списке."} Дисциплины назначаются в карточке студента.</p></div></div><form class="daily-toolbar panel daily-panel" id="teacher-add"><label>ФИО нового преподавателя<input name="name" required minlength="3" maxlength="150" autocomplete="off"></label><button class="btn primary">+ Добавить преподавателя</button></form>${admin ? `<section class="panel daily-panel" id="staff-access"><div class="daily-toolbar"><h2>Учебный офис</h2><button type="button" class="btn small" id="invite-export">Выгрузить коды приглашения</button>${mode.enabled ? '<span class="pill">Вход только по личным паролям</span>' : '<button type="button" class="btn small" id="personal-only">Включить вход только по личным паролям</button>'}</div>${staffAccess.map((m) => `<div class="daily-row" data-person="${esc(m.id)}"><span><strong>${esc(m.name)}</strong><br>${accessLine(m)}</span><span class="daily-options">${accessButton(m)}</span></div>`).join("")}</section>` : ""}<section class="panel daily-panel"><div class="daily-toolbar"><input type="search" id="teacher-search" placeholder="Найти преподавателя" aria-label="Найти преподавателя"><button type="button" class="btn small" id="teacher-silent" aria-pressed="${silentOnly}">Без отметок за 7 дней <span class="count">${teachers.filter(silent).length}</span></button><button type="button" class="btn small" id="teacher-no-access" aria-pressed="false">Без доступа <span class="count">${teachers.filter(withoutAccess).length}</span></button><span class="muted">Всего: ${teachers.length}</span></div><div id="teacher-rows"></div><div class="daily-toolbar"><button class="btn" id="teacher-more" hidden>Показать ещё</button><span class="muted" id="teacher-count"></span></div></section>`;
  // Список из сотен преподавателей показывается порциями по 50.
  const PAGE = 50;
  let limit = PAGE;
  const render = () => {
    const q = root
      .querySelector("#teacher-search")
      .value.trim()
      .toLocaleLowerCase("ru")
      .replaceAll("ё", "е");
    const found = teachers.filter(
      (t) =>
        t.name.toLocaleLowerCase("ru").replaceAll("ё", "е").includes(q) &&
        (!silentOnly || silent(t)) &&
        (!noAccessOnly || withoutAccess(t)),
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
            `<div class="daily-row" data-teacher="${esc(t.id)}"><span><strong>${esc(t.name)}</strong><br><span class="muted">${t.courses.length ? t.courses.map(esc).join(" · ") : "Нет дисциплин и студентов"}</span>${t.students ? `<br><button type="button" class="button-link" data-action="students">${plural(t.students, ["студент", "студента", "студентов"])} →</button> <span class="${silent(t) ? "pill red" : "muted"}">${t.lastMark ? "последняя отметка " + fmtDate(t.lastMark, { day: "numeric", month: "short" }) : "отметок нет"}</span>` : ""}<br>${accessLine(t)}</span>${admin || t.canManageAccess ? `<span class="daily-options">${t.canManageAccess ? accessButton(t) : ""}${admin ? `<button class="btn small" data-action="rename">Изменить ФИО</button><button class="btn small" data-action="delete" ${t.courses.length ? 'disabled title="Сначала снимите связи со студентами"' : ""}>Удалить</button>` : ""}</span>` : ""}</div>`,
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
  root.querySelector("#teacher-silent").onclick = () => {
    silentOnly = !silentOnly;
    root
      .querySelector("#teacher-silent")
      .setAttribute("aria-pressed", String(silentOnly));
    limit = PAGE;
    render();
  };
  root.querySelector("#teacher-no-access").onclick = () => {
    noAccessOnly = !noAccessOnly;
    root
      .querySelector("#teacher-no-access")
      .setAttribute("aria-pressed", String(noAccessOnly));
    limit = PAGE;
    render();
  };
  render();
  // Выдача кода или сброс пароля; сброс сначала спрашивает – он выкидывает человека отовсюду.
  async function grantAccess(person) {
    if (
      person.access.state === "active" &&
      !(await ask({
        title: "Сбросить пароль?",
        text: `${person.name} выйдет из журнала на всех устройствах и войдёт снова по новому коду.`,
        ok: "Сбросить",
        danger: true,
      }))
    )
      return false;
    const invite = await api(
      "/api/admin/access/" + encodeURIComponent(person.id),
      { method: "POST" },
    );
    showInvite(invite, { esc });
    return true;
  }
  root.querySelector("#personal-only")?.addEventListener("click", async () => {
    try {
      if (await enablePersonalOnly({ api, ask })) {
        toast("Вход только по личным паролям включён");
        await again();
      }
    } catch (err) {
      toast(err.message, true);
    }
  });
  root.querySelector("#invite-export")?.addEventListener("click", async () => {
    try {
      if (await exportInvites({ ask })) {
        toast("Файл с кодами скачан. Удалите его после рассылки");
        await again();
      }
    } catch (err) {
      toast(err.message, true);
    }
  });
  root.querySelector("#staff-access")?.addEventListener("click", async (e) => {
    const id = e.target.closest("[data-person]")?.dataset.person,
      person = staffAccess.find((m) => m.id === id);
    if (e.target.dataset.action !== "access" || !person) return;
    try {
      if (await grantAccess(person)) await again();
    } catch (err) {
      toast(err.message, true);
    }
  });
  root.querySelector("#teacher-rows").onclick = async (e) => {
    const action = e.target.dataset.action,
      id = e.target.closest("[data-teacher]")?.dataset.teacher,
      teacher = teachers.find((t) => t.id === id);
    if (!action || !teacher) return;
    if (action === "students") return openStudents(teacher);
    if (action === "cancel") return render();
    try {
      if (action === "access") {
        if (await grantAccess(teacher)) await again();
        return;
      }
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
      const added = await api("/api/admin/teachers", {
        method: "POST",
        body: JSON.stringify({
          name: new FormData(e.currentTarget).get("name"),
        }),
      });
      toast("Преподаватель добавлен в реестр");
      // Менеджер выдаёт доступ только преподавателям со студентами своих программ,
      // а у нового преподавателя студентов ещё нет.
      if (
        admin &&
        (await ask({
          title: "Выдать доступ новому преподавателю?",
          text: `${added.name} получит логин и код для первого входа.`,
          ok: "Выдать доступ",
        }))
      )
        await grantAccess({ ...added, access: { state: "none" } });
      else if (!admin)
        toast(
          "Доступ можно будет выдать, когда у преподавателя появятся студенты ваших программ",
        );
      await again();
    } catch (err) {
      toast(err.message, true);
    }
  };
}
