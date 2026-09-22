// Чтение таблиц из .xlsx без внешних зависимостей: zip разбирается по центральному каталогу,
// XML листов – регулярными выражениями. Достаточно для файлов из Excel и openpyxl.
import { inflateRawSync } from "node:zlib";

function unzip(buffer) {
  const files = new Map();
  let eocd = buffer.length - 22;
  while (eocd >= 0 && buffer.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error("Файл не похож на .xlsx");
  const count = buffer.readUInt16LE(eocd + 10);
  let p = buffer.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(p) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(p + 10),
      size = buffer.readUInt32LE(p + 20),
      nameLength = buffer.readUInt16LE(p + 28),
      extraLength = buffer.readUInt16LE(p + 30),
      commentLength = buffer.readUInt16LE(p + 32),
      local = buffer.readUInt32LE(p + 42),
      name = buffer.toString("utf8", p + 46, p + 46 + nameLength);
    const start =
      local +
      30 +
      buffer.readUInt16LE(local + 26) +
      buffer.readUInt16LE(local + 28);
    const raw = buffer.subarray(start, start + size);
    files.set(name, method === 8 ? inflateRawSync(raw) : raw);
    p += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

const decode = (s) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");
const text = (xml) =>
  decode(
    [...xml.matchAll(/<t\b[^>]*>([^<]*)<\/t>/g)].map((m) => m[1]).join(""),
  );
const column = (ref) =>
  [...ref.replace(/\d+/g, "")].reduce(
    (n, ch) => n * 26 + ch.charCodeAt(0) - 64,
    0,
  ) - 1;

// Возвращает { [имя листа]: массив строк, каждая строка – массив значений по колонкам }.
export function readWorkbook(buffer) {
  const files = unzip(buffer);
  const xml = (name) => files.get(name)?.toString("utf8") || "";
  const shared = [
    ...xml("xl/sharedStrings.xml").matchAll(/<si>(.*?)<\/si>/gs),
  ].map((m) => text(m[1]));
  const rels = Object.fromEntries(
    [
      ...xml("xl/_rels/workbook.xml.rels").matchAll(/<Relationship\b[^>]*>/g),
    ].map((m) => [
      m[0].match(/Id="([^"]+)"/)[1],
      m[0].match(/Target="([^"]+)"/)[1].replace(/^\/?(xl\/)?/, "xl/"),
    ]),
  );
  const sheets = {};
  for (const m of xml("xl/workbook.xml").matchAll(/<sheet\b[^>]*>/g)) {
    const name = decode(m[0].match(/name="([^"]*)"/)[1]),
      id = m[0].match(/r:id="([^"]+)"/)[1];
    const rows = [];
    for (const r of xml(rels[id]).matchAll(/<row\b[^>]*>(.*?)<\/row>/gs)) {
      const row = [];
      for (const c of r[1].matchAll(/<c\b([^>]*?)(?:\/>|>(.*?)<\/c>)/gs)) {
        const ref = c[1].match(/r="([A-Z]+)\d+"/)?.[1] || "",
          type = c[1].match(/t="([^"]+)"/)?.[1],
          inner = c[2] || "";
        let value = "";
        if (type === "s")
          value = shared[Number(inner.match(/<v>([^<]*)<\/v>/)?.[1])] ?? "";
        else if (type === "inlineStr") value = text(inner);
        else value = decode(inner.match(/<v>([^<]*)<\/v>/)?.[1] ?? "");
        if (ref) row[column(ref)] = value;
      }
      rows.push(row);
    }
    sheets[name] = rows;
  }
  return sheets;
}
