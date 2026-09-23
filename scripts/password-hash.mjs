// Печатает строку MANAGEMENT_PASSWORD_HASH для .env. Пароль вводится с клавиатуры
// и не попадает ни в историю команд, ни в список процессов.
import { createInterface } from "node:readline/promises";
import { passwordHash } from "../src/management-auth.js";

const rl = createInterface({ input: process.stdin, output: process.stderr });
const password = await rl.question("Пароль журнала: ");
rl.close();
if (!password) {
  process.stderr.write("Пароль пустой, строка не создана\n");
  process.exit(1);
}
process.stdout.write(
  "MANAGEMENT_PASSWORD_HASH=" + passwordHash(password) + "\n",
);
