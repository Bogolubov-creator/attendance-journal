import { randomBytes, scrypt, scryptSync, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
export const scryptAsync = promisify(scrypt);
export function passwordHash(password) {
  const salt = randomBytes(16).toString("hex");
  return salt + ":" + scryptSync(password, salt, 64).toString("hex");
}
// Разбор сохранённого хеша: null, если пароль или хеш заведомо не подходят.
function parseHash(password, encoded) {
  if (
    typeof password !== "string" ||
    password.length > 256 ||
    !/^[a-f0-9]{32}:[a-f0-9]{128}$/.test(encoded || "")
  )
    return null;
  const [salt, expected] = encoded.split(":");
  return { salt, expected: Buffer.from(expected, "hex") };
}
export function verifyPassword(password, encoded) {
  const h = parseHash(password, encoded);
  return !!h && timingSafeEqual(scryptSync(password, h.salt, 64), h.expected);
}
// То же в пуле потоков: сервер отвечает другим, пока считается scrypt.
export async function passwordHashAsync(password) {
  const salt = randomBytes(16).toString("hex");
  return salt + ":" + (await scryptAsync(password, salt, 64)).toString("hex");
}
export async function verifyPasswordAsync(password, encoded) {
  const h = parseHash(password, encoded);
  return (
    !!h && timingSafeEqual(await scryptAsync(password, h.salt, 64), h.expected)
  );
}
