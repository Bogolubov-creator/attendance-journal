// Сборка zip в памяти для тестов разбора xlsx: записи сжимаются deflate или берутся как есть (raw).
import { deflateRawSync } from "node:zlib";

export function buildZip(entries) {
  const locals = [],
    central = [];
  let offset = 0;
  for (const { name, data, raw } of entries) {
    const nameBuf = Buffer.from(name),
      body = raw ?? deflateRawSync(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data?.length ?? 0, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(data?.length ?? 0, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, body);
    central.push(dir, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const dirBuf = Buffer.concat(central),
    eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(dirBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dirBuf, eocd]);
}

const MB = 1024 * 1024;

// Книга с листами «База», «Второй» …: каждый лист – строка XML с заданным числом нулевых байт в конце.
export function workbook(sheets, extra = []) {
  const names = Object.keys(sheets);
  return buildZip([
    {
      name: "xl/workbook.xml",
      data: Buffer.from(
        "<workbook><sheets>" +
          names
            .map(
              (n, i) =>
                `<sheet name="${n}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`,
            )
            .join("") +
          "</sheets></workbook>",
      ),
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: Buffer.from(
        "<Relationships>" +
          names
            .map(
              (_, i) =>
                `<Relationship Id="rId${i + 1}" Target="worksheets/sheet${i + 1}.xml"/>`,
            )
            .join("") +
          "</Relationships>",
      ),
    },
    ...names.map((n, i) => ({
      name: `xl/worksheets/sheet${i + 1}.xml`,
      data: Buffer.concat([
        Buffer.from(
          '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>ok</t></is></c></row></sheetData></worksheet>',
        ),
        Buffer.alloc(sheets[n] * MB),
      ]),
    })),
    ...extra,
  ]);
}
