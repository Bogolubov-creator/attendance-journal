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
    if (matches.length !== 1)
      throw Object.assign(
        new Error(
          "В РУЗ нет единственного точного совпадения преподавателя. Требуется ручное сопоставление.",
        ),
        { status: 409 },
      );
    return fetchData(
      `schedule/lecturer/${encodeURIComponent(matches[0].id)}?${dates}`,
    );
  }
}
