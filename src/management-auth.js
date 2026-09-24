import { randomBytes, scrypt, scryptSync, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
const scryptAsync = promisify(scrypt);
export function passwordHash(password) {
  const salt = randomBytes(16).toString("hex");
  return salt + ":" + scryptSync(password, salt, 64).toString("hex");
}
export function verifyPassword(password, encoded) {
  if (
    typeof password !== "string" ||
    password.length > 256 ||
    !/^[a-f0-9]{32}:[a-f0-9]{128}$/.test(encoded || "")
  )
    return false;
  const [salt, expected] = encoded.split(":");
  return timingSafeEqual(
    scryptSync(password, salt, 64),
    Buffer.from(expected, "hex"),
  );
}
// То же в пуле потоков: сервер отвечает другим, пока считается scrypt.
export async function passwordHashAsync(password) {
  const salt = randomBytes(16).toString("hex");
  return salt + ":" + (await scryptAsync(password, salt, 64)).toString("hex");
}
export async function verifyPasswordAsync(password, encoded) {
  if (
    typeof password !== "string" ||
    password.length > 256 ||
    !/^[a-f0-9]{32}:[a-f0-9]{128}$/.test(encoded || "")
  )
    return false;
  const [salt, expected] = encoded.split(":");
  return timingSafeEqual(
    await scryptAsync(password, salt, 64),
    Buffer.from(expected, "hex"),
  );
}
