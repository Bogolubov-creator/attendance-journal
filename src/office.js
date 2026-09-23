// Базовое распределение ЦУУП; администратор журнала заменён по указанию владельца 21.09.2026.
export const directorySource = "https://pravo.hse.ru/centre/contact";
const scope = (program, year = null) => ({ program, year });
export const managers = [
  {
    id: "gadzhieva",
    name: "Гаджиева Альбина Омаровна",
    role: "admin",
    title: "Администратор журнала",
    scopes: [scope("Право", 4)],
  },
  {
    id: "chinkova",
    name: "Чинкова Алиса Павловна",
    role: "admin",
    title: "Заместитель директора",
    scopes: [scope("Публичное право"), scope("Юрист в бизнесе")],
  },
  {
    id: "akhmyatzhanov",
    name: "Ахмятжанов Артём Русланович",
    role: "office",
    scopes: [scope("Юриспруденция", 1)],
  },
  {
    id: "smirnova",
    name: "Смирнова Екатерина Дмитриевна",
    role: "office",
    scopes: [scope("Юриспруденция", 2)],
  },
  {
    id: "motorov",
    name: "Моторов Дмитрий Аркадьевич",
    role: "office",
    scopes: [scope("Юриспруденция", 3)],
  },
  {
    id: "demchenko",
    name: "Демченко Елизавета Васильевна",
    role: "office",
    // 5 курс «Юриспруденции» отдан Демченко по решению владельца 22.09.2026 (на странице ЦУУП его нет).
    scopes: [scope("Право", 5), scope("Юриспруденция", 5)],
  },
  {
    id: "lyashchenko",
    name: "Лященко Даниил Андреевич",
    role: "office",
    scopes: [scope("Юриспруденция: цифровой юрист"), scope("Цифровой юрист")],
  },
  {
    id: "strokova",
    name: "Строкова Юлия Ивановна",
    role: "office",
    scopes: [
      scope("Комплаенс и профилактика правовых рисков"),
      scope("Комплаенс и профилактика правовых рисков (совместная с ЧГУ)"),
      scope("Сравнительное правоведение и фундаментальный правовой анализ"),
      scope("Цифровое право"),
    ],
  },
  {
    id: "varzina",
    name: "Варзина Татьяна Сергеевна",
    role: "office",
    scopes: [
      scope("Современное частное право"),
      scope("Фармправо и здравоохранение"),
      scope("Юрист в правосудии"),
    ],
  },
  {
    id: "polyanskaya",
    name: "Полянская Ольга Владимировна",
    role: "office",
    scopes: [
      scope("Право международной торговли и разрешение споров"),
      scope("ЛигалТех"),
    ],
  },
];
export const programs = [
  ...new Set(managers.flatMap((m) => m.scopes.map((s) => s.program))),
];
export function managerFor(student) {
  if (!student.program || !student.year) return null;
  return (
    managers.find((m) =>
      m.scopes.some(
        (s) =>
          s.program === student.program &&
          (s.year === null || s.year === student.year),
      ),
    ) || null
  );
}
// Менеджер видит только студентов своих программ и курсов; полный доступ – всех.
export function canSeeStudent(user, student) {
  return user.role === "admin" || managerFor(student)?.id === user.id;
}
export function canEditStudent(user, student) {
  return (
    user.role === "admin" ||
    (user.role === "office" && managerFor(student)?.id === user.id)
  );
}
// Перечень для проверки применимости сотрудником, а не универсальные обязанности.
export const procedureCatalog = [
  {
    id: "registration",
    title: "Миграционный учёт",
    source: "https://ivisa.hse.ru/",
    hint: "Проверить основание пребывания, дату въезда и место проживания. При изменениях нужна повторная проверка.",
    closedBy: "staff",
  },
  {
    id: "visa",
    title: "Виза и срок пребывания",
    source: "https://ivisa.hse.ru/",
    hint: "Применимость зависит от гражданства и основания пребывания. Безвизовый въезд не означает отсутствие ограничений по срокам.",
    closedBy: "staff",
  },
  {
    id: "medical",
    title: "Медицинское освидетельствование",
    source: "https://ivisa.hse.ru/medst",
    hint: "Проверить исключения и срок действия подтверждения. В журнале хранится статус, без диагнозов и результатов анализов.",
    closedBy: "staff",
  },
  {
    id: "fingerprints",
    title: "Дактилоскопия и фотографирование",
    source: "https://ivisa.hse.ru/medst",
    hint: "Проверить применимость и ранее пройденную процедуру. Не назначать повтор автоматически.",
    closedBy: "staff",
  },
  {
    id: "insurance",
    title: "Медицинское страхование",
    source: "https://istudents.hse.ru/",
    hint: "Проверить подходящее основание медицинского обеспечения и срок действия полиса.",
    closedBy: "staff",
  },
];
export const procedureStates = [
  "unknown",
  "pending",
  "submitted",
  "confirmed",
  "exempt",
];
export function procedureStatus(record, today) {
  if (!record || record.state === "unknown") return "unknown";
  if (record.state === "exempt") return "exempt";
  if (record.state === "confirmed")
    return record.validUntil && record.validUntil < today
      ? "expired"
      : "confirmed";
  if (record.state === "submitted") return "submitted";
  return record.dueDate && record.dueDate < today ? "overdue" : "pending";
}
export function validDate(value) {
  return (
    value === "" ||
    (typeof value === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(value) &&
      Number(value.slice(0, 4)) >= 1900 &&
      !Number.isNaN(Date.parse(value)) &&
      new Date(value).toISOString().slice(0, 10) === value)
  );
}
// Поля карточки, которые студент правит сам. Учебные поля (программа, курс,
// статус контингента, версия программы, куратор) меняет только сотрудник.
export const studentEditableFields = [
  "citizenship",
  "nameLatin",
  "sendingCountry",
  "arrivalDate",
  "residence",
  "passportUntil",
  "migrationCardUntil",
  "housing",
  "inRussia",
];
export function pickStudentFields(body, previous) {
  const result = { ...previous };
  for (const field of studentEditableFields)
    if (field in body) result[field] = body[field];
  return result;
}
