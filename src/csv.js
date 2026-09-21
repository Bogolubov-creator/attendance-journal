// Кавычки защищают разделители; апостроф запрещает Excel выполнять формулы.
export function csvCell(value) {
  return (
    '"' +
    String(value ?? "")
      .replace(/^[\s]*[=+@-]/, "'$&")
      .replaceAll('"', '""') +
    '"'
  );
}
