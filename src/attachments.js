import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";

// Тип файла проверяется по первым байтам, а не по расширению или
// заголовку content-type – их студент может подставить любые.
const signatures = [
  { ext: "pdf", mime: "application/pdf", magic: [0x25, 0x50, 0x44, 0x46] },
  { ext: "jpg", mime: "image/jpeg", magic: [0xff, 0xd8, 0xff] },
  {
    ext: "png",
    mime: "image/png",
    magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  },
];

export function detectType(buffer) {
  return (
    signatures.find((s) => s.magic.every((byte, i) => buffer[i] === byte)) ||
    null
  );
}

// Имя на диске производит журнал: присланное студентом имя нигде не участвует в пути.
export function saveAttachment({ dir, studentId, buffer, ext }) {
  const folder = path.join(dir, studentId);
  mkdirSync(folder, { recursive: true });
  const storedName = randomBytes(16).toString("hex") + "." + ext;
  const target = path.join(folder, storedName);
  try {
    writeFileSync(target, buffer);
  } catch (error) {
    rmSync(target, { force: true });
    throw error;
  }
  return {
    storedName,
    size: buffer.length,
    sha256: createHash("sha256").update(buffer).digest("hex"),
  };
}

export const attachmentPath = (dir, studentId, storedName) =>
  path.join(dir, studentId, storedName);
