// Страница ограничения сети не является пустым расписанием.
export function parseRuzResponse(text, url = "") {
  const fail = (message, code) =>
    Object.assign(new Error(message), { status: 502, code });
  if (
    url.startsWith("https://www.hse.ru/eduland/schedule/") ||
    /Доступ к[\s\S]{0,50}РУЗ[\s\S]{0,100}внутренней сети/.test(text)
  ) {
    throw fail(
      "РУЗ доступен только из сети ВШЭ. Подключите компьютер с сервером журнала к сети ВШЭ или университетскому VPN и повторите загрузку. Сохранённые занятия и отметки доступны.",
      "RUZ_NETWORK_REQUIRED",
    );
  }
  if (!text.trim())
    throw fail(
      "РУЗ вернул пустой ответ. Сохранённые данные оставлены; повтор запланирован.",
      "RUZ_EMPTY_RESPONSE",
    );
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw fail("Не удалось прочитать ответ РУЗ. Повтор запланирован.");
  }
  if (!Array.isArray(data)) throw fail("РУЗ вернул неожиданный формат");
  return data;
}

// Двойные карточки одного человека в РУЗ: собираем расписание со всех, пустые пропускаем.
async function mergeSchedules(fetchData, paths) {
  const seen = new Set(),
    entries = [];
  let answered = 0;
  for (const path of paths) {
    let data;
    try {
      data = await fetchData(path);
    } catch (error) {
      if (error.code !== "RUZ_EMPTY_RESPONSE") throw error;
      continue;
    }
    answered++;
    for (const e of data) {
      const key = [e.lessonOid, e.date, e.beginLesson, e.groupOid].join("|");
      if (!seen.has(key)) {
        seen.add(key);
        entries.push(e);
      }
    }
  }
  return answered ? entries : null;
}

// Старые person ID сохраняем; lecturer используем только при пустом теле ответа.
export async function loadTeacherSchedule(fetchData, name, personId, dates) {
  try {
    return await fetchData(
      `schedule/person/${encodeURIComponent(personId)}?${dates}`,
    );
  } catch (error) {
    if (error.code !== "RUZ_EMPTY_RESPONSE") throw error;
    const people = await fetchData(
      "search?type=lecturer&term=" + encodeURIComponent(name),
    );
    const matches = people.filter((p) => p.label?.trim() === name);
    if (!matches.length)
      throw Object.assign(
        new Error(
          "В РУЗ нет точного совпадения преподавателя. Требуется ручное сопоставление.",
        ),
        { status: 409 },
      );
    const paths = matches.map(
      (m) => `schedule/lecturer/${encodeURIComponent(m.id)}?${dates}`,
    );
    return (await mergeSchedules(fetchData, paths)) ?? fetchData(paths[0]);
  }
}

export async function loadSchedules(fetchData, name, personIds, dates) {
  if (personIds.length === 1)
    return loadTeacherSchedule(fetchData, name, personIds[0], dates);
  const merged = await mergeSchedules(
    fetchData,
    personIds.map((id) => `schedule/person/${encodeURIComponent(id)}?${dates}`),
  );
  return merged ?? loadTeacherSchedule(fetchData, name, personIds[0], dates);
}
