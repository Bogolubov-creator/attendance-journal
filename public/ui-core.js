// Общее для журнала (app.js) и кабинета студента (student.js): экранирование,
// запрос к API, уведомление, размер файла и подписи статусов и полей студента.
// Обработка ответа 401 у страниц разная, поэтому её передаёт вызывающий в createApi.
export const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export const fmtSize = (n) =>
  n < 1024 * 1024
    ? Math.round(n / 1024) + " КБ"
    : (n / 1024 / 1024).toFixed(1) + " МБ";
export function createApi(onUnauthorized) {
  return async function api(path, options = {}) {
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
      if (r.status === 401) onUnauthorized();
      throw Object.assign(Error(data.error || "Не удалось выполнить запрос"), {
        status: r.status,
      });
    }
    return data;
  };
}
let toastTimer;
// Ошибка остаётся на экране, пока её не закроют; обычное уведомление исчезает само.
export function toast(message, error = false) {
  const el = document.querySelector("#toast");
  if (!el) return;
  el.innerHTML =
    `<span>${esc(message)}</span>` +
    (error
      ? '<button type="button" class="toast-close" aria-label="Закрыть уведомление">×</button>'
      : "");
  el.className = "show" + (error ? " error" : "");
  el.setAttribute("role", error ? "alert" : "status");
  // Popover живёт в верхнем слое, поэтому уведомление видно и поверх модальных окон.
  const hide = () => {
    el.className = "";
    if (el.matches(":popover-open")) el.hidePopover();
  };
  if (el.showPopover && !el.matches(":popover-open")) el.showPopover();
  clearTimeout(toastTimer);
  if (error) el.querySelector(".toast-close").onclick = hide;
  else toastTimer = setTimeout(hide, 5500);
}
export async function safe(fn) {
  try {
    await fn();
  } catch (e) {
    toast(e.message, true);
  }
}
// Статусы требования – одна подпись в карточке сотрудника и в кабинете студента.
export const procedureLabels = {
  unknown: "Нет данных",
  pending: "Не выполнено",
  submitted: "На проверке",
  confirmed: "Подтверждено",
  exempt: "Не требуется",
  overdue: "Просрочено",
  expired: "Истёк срок действия",
};
// Подписи перечислений карточки студента; порядок ключей – порядок в списке.
export const foreignStatusLabels = {
  unknown: "Не проверено",
  confirmed: "Подтверждён",
  excluded: "Не входит",
};
export const enrollmentStatusLabels = {
  active: "Обучается",
  leave: "Академический отпуск",
  graduated: "Выпускник",
  withdrawn: "Отчислен",
};
export const residenceLabels = {
  "": "Не указано",
  visa: "Виза",
  visa_free: "Безвизовый въезд",
  rvp: "РВП",
  rvpo: "РВПО",
  residence_permit: "ВНЖ",
  other: "Другое",
};
export const inRussiaLabels = { "": "Не указано", yes: "Да", no: "Нет" };
export const housingLabels = {
  "": "Не указано",
  dormitory: "Общежитие",
  private: "Частный адрес",
};
