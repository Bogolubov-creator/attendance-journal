import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
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
