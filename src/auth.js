import { readFileSync } from "node:fs";
import { randomBytes, createHash } from "node:crypto";
import * as oidc from "openid-client";
import { verifyPassword } from "./management-auth.js";
import { managers } from "./office.js";
import { findPerson } from "./staff-accounts.js";

const token = () => randomBytes(32).toString("base64url"),
  hash = (s) => createHash("sha256").update(s).digest("hex");

// Учётки университетского входа из data/accounts.json; в рабочем режиме без
// параметров OIDC и подтверждённой административной учётки сервер не запускается.
export function loadAccounts({ demo, selection }) {
  let accounts = [];
  try {
    accounts = JSON.parse(readFileSync("data/accounts.json", "utf8"));
  } catch {}
  if (!selection && (!demo || process.env.REQUIRE_AUTH_CONFIG === "true")) {
    if (
      !process.env.OIDC_ISSUER?.startsWith("https://") ||
      !process.env.OIDC_CLIENT_ID ||
      !process.env.OIDC_CLIENT_SECRET
    )
      throw Error(
        "Заполните параметры университетской авторизации до запуска сервера",
      );
    if (
      !accounts.some(
        (a) =>
          a.role === "admin" && a.subject && /^[^\s@]+@hse\.ru$/.test(a.email),
      )
    )
      throw Error(
        "Укажите подтверждённую административную учётку в data/accounts.json",
      );
  }
  return accounts;
}

// Вход и сессии: общий пароль с ограничением попыток, вход выбором и демо-вход,
// университетский вход (OIDC), выход. Подключается сразу после разбора JSON:
// прослойка сессии должна идти раньше всех маршрутов.
export function registerAuth(
  app,
  {
    get,
    run,
    roster,
    demo,
    demoStudentLogin,
    selection,
    origin,
    accounts,
    fail,
    cabinetOpen,
    studentByExternalId,
    staff,
    audit,
  },
) {
  const managementHash = process.env.MANAGEMENT_PASSWORD_HASH || "";
  const managementVersion = hash(managementHash);
  const loginAttempts = new Map();
  // Время неверных попыток со всех адресов за последние 15 минут (не больше 30).
  let passwordFailures = [];
  function checkManagementPassword(req) {
    if (!managementHash) throw fail(503, "Пароль ещё не настроен");
    const now = Date.now();
    for (const [key, value] of loginAttempts)
      if (value.until <= now) loginAttempts.delete(key);
    passwordFailures = passwordFailures.filter((t) => t > now - 15 * 60000);
    const key = req.ip;
    const attempt = loginAttempts.get(key) || {
      count: 0,
      until: now + 15 * 60000,
    };
    if (attempt.count >= 5 || passwordFailures.length >= 30)
      throw fail(429, "Слишком много попыток. Повторите через 15 минут.");
    if (!verifyPassword(req.body.password, managementHash)) {
      attempt.count++;
      passwordFailures.push(now);
      loginAttempts.set(key, attempt);
      throw fail(403, "Неверный пароль");
    }
    loginAttempts.delete(key);
  }
  app.use((req, res, next) => {
    const id = req.headers.cookie
      ?.split("; ")
      .find((x) => x.startsWith("journal="))
      ?.slice(8);
    const row =
      id &&
      get(
        "SELECT * FROM sessions WHERE id=? AND expires>?",
        hash(id),
        Date.now(),
      );
    req.session = row ? JSON.parse(row.data) : null;
    req.sessionKey = row?.id;
    // Любая сессия, кроме университетского входа, выдана по общему паролю
    // и закрывается при его смене.
    if (
      req.session?.user &&
      !["oidc", "explicit", "personal"].includes(req.session.user.source) &&
      (!managementHash || req.session.managementVersion !== managementVersion)
    ) {
      run("DELETE FROM sessions WHERE id=?", req.sessionKey);
      req.session = null;
    }

    if (req.session?.user?.source === "personal") {
      // Личный пароль: сессия живёт, пока жива учётная запись, не сменилась
      // версия пароля и человек остался в справочнике или реестре с той же ролью.
      const u = req.session.user;
      const account = staff.byPerson(u.id);
      if (
        !account?.passwordHash ||
        account.passwordVersion !== u.passwordVersion ||
        findPerson(u.id, roster)?.role !== u.role
      ) {
        run("DELETE FROM sessions WHERE id=?", req.sessionKey);
        req.session = null;
      }
    } else if (req.session?.user?.role === "student") {
      const u = req.session.user;
      const valid =
        cabinetOpen(u.studentId) &&
        (u.source === "demo"
          ? demoStudentLogin
          : studentByExternalId(u.subject) === u.studentId);
      if (!valid) {
        run("DELETE FROM sessions WHERE id=?", req.sessionKey);
        req.session = null;
      }
    } else if (selection && req.session?.user?.source === "selection") {
      const u = req.session.user;
      const valid =
        u.role === "teacher"
          ? roster.teachers.some((t) => t.id === u.id)
          : managers.some((m) => m.id === u.id && m.role === u.role);
      if (!valid) {
        run("DELETE FROM sessions WHERE id=?", req.sessionKey);
        req.session = null;
      }
    } else if (!demo && req.session?.user) {
      const u = req.session.user;
      const valid = accounts.some(
        (a) =>
          a.subject === u.subject &&
          a.email.toLowerCase() === u.email &&
          a.role === u.role &&
          (u.role === "admin" || a.teacherId === u.id),
      );
      if (!valid) {
        run("DELETE FROM sessions WHERE id=?", req.sessionKey);
        req.session = null;
      }
    }
    next();
  });
  function session(res, data, lifetime = 8 * 3600000) {
    const id = token();
    run("DELETE FROM sessions WHERE expires<?", Date.now());
    run(
      "INSERT INTO sessions VALUES(?,?,?)",
      hash(id),
      JSON.stringify(data),
      Date.now() + lifetime,
    );
    res.cookie("journal", id, {
      httpOnly: true,
      sameSite: "lax",
      secure: !demo,
      maxAge: lifetime,
      path: "/",
    });
  }
  // Сессия по личному паролю: версия пароля нужна прослойке для отзыва.
  function personalSession(req, res, account, lifetime) {
    const person = findPerson(account.personId, roster);
    if (req.sessionKey) run("DELETE FROM sessions WHERE id=?", req.sessionKey);
    const user = {
      ...person,
      login: account.login,
      source: "personal",
      passwordVersion: account.passwordVersion,
    };
    session(res, { user }, lifetime);
    return user;
  }
  const auth = (req, res, next) =>
    req.session?.user
      ? next()
      : res.status(401).json({ error: "Войдите в свой кабинет" });
  const admin = (req, res, next) =>
    ["admin", "office"].includes(req.session?.user?.role)
      ? next()
      : res.status(403).json({ error: "Доступ только для учебного офиса" });
  app.get("/api/session", (req, res) =>
    res.json({
      user: req.session?.user || null,
      demo: demo && process.env.DATA_MODE !== "live",
      demoStudents: demoStudentLogin ? roster.students : [],
      selection,
      teachers: selection ? roster.teachers : [],
      managers: selection ? managers : [],
    }),
  );
  app.post("/api/select-login", (req, res) => {
    if (!selection) return res.sendStatus(404);
    const { role, personId } = req.body;
    const person =
      role === "teacher"
        ? roster.teachers.find((t) => t.id === personId)
        : managers.find((m) => m.id === personId && m.role === role);
    if (!person || !["teacher", "office", "admin"].includes(role))
      throw fail(400, "Выберите роль и сотрудника из списка");
    checkManagementPassword(req);
    if (req.sessionKey) run("DELETE FROM sessions WHERE id=?", req.sessionKey);
    const user = { ...person, role, source: "selection" };
    session(res, { user, managementVersion });
    res.json({ user });
  });
  // Неверные личные пароли по всем учётным записям за 15 минут: потолок
  // против перебора одного пароля по многим логинам. По адресу не считаем –
  // за туннелем адрес у всех посетителей один.
  let personalFailures = [];
  app.post("/api/login", (req, res) => {
    const now = Date.now();
    personalFailures = personalFailures.filter((t) => t > now - 15 * 60000);
    if (personalFailures.length >= 100)
      throw fail(429, "Слишком много попыток. Повторите через 15 минут.");
    const { login, password, remember } = req.body;
    const result = staff.checkPassword(login, password, now);
    if (result.locked)
      throw fail(
        429,
        "Вход в эту учётную запись закрыт на 15 минут после неверных попыток",
      );
    const person =
      result.account && findPerson(result.account.personId, roster);
    if (!person) {
      personalFailures.push(now);
      throw fail(403, "Неверный логин или пароль");
    }
    // Запомнить на 30 дней можно только преподавателю: у офиса доступ к данным студентов.
    const lifetime =
      remember === true && person.role === "teacher"
        ? 30 * 86400000
        : 8 * 3600000;
    const user = personalSession(req, res, result.account, lifetime);
    audit(user, "access.login", user.id, user.name);
    res.json({ user });
  });
  // Смена своего пароля. Остальные сессии гаснут вместе с прежней версией пароля,
  // текущему устройству выдаётся новая сессия на оставшийся срок.
  app.post("/api/account/password", (req, res) => {
    const u = req.session?.user;
    if (u?.source !== "personal")
      throw fail(403, "Смена пароля – для входа по личному паролю");
    const { current, next } = req.body;
    const result = staff.changePassword(u.id, current, next);
    if (result.error) throw fail(result.status, result.error);
    const expires = get(
      "SELECT expires FROM sessions WHERE id=?",
      req.sessionKey,
    )?.expires;
    const user = personalSession(
      req,
      res,
      result.account,
      Math.max(expires - Date.now(), 60000) || undefined,
    );
    audit(user, "access.password", user.id, user.name);
    res.json({ ok: true });
  });
  // Первый вход по коду приглашения: сотрудник сам задаёт пароль.
  app.post("/api/first-login", (req, res) => {
    const { login, code, password } = req.body;
    const result = staff.redeemInvite(login, code, password);
    if (result.error) throw fail(result.status, result.error);
    if (!findPerson(result.account.personId, roster))
      throw fail(403, "Учётная запись не относится к сотрудникам журнала");
    const user = personalSession(req, res, result.account);
    audit(user, "access.first-login", user.id, user.name);
    res.json({ user });
  });
  app.post("/api/demo-login", (req, res) => {
    if (!demo) return res.sendStatus(404);
    const role = req.body.role;
    checkManagementPassword(req);
    if (role === "student") {
      if (!demoStudentLogin) throw fail(403, "Демо-вход студентом отключён");
      const student = roster.students.find((s) => s.id === req.body.studentId);
      if (!student) throw fail(400, "Выберите студента");
      if (!cabinetOpen(student.id))
        throw fail(403, "Личный кабинет закрыт: обучение завершено");
      if (req.sessionKey)
        run("DELETE FROM sessions WHERE id=?", req.sessionKey);
      const user = {
        id: student.id,
        name: student.name,
        role: "student",
        studentId: student.id,
        source: "demo",
      };
      session(res, { user, managementVersion });
      return res.json({ user });
    }
    const teacher = roster.teachers.find((t) => t.id === req.body.teacherId);
    if (role !== "admin" && !teacher) throw fail(400, "Выберите преподавателя");
    if (req.sessionKey) run("DELETE FROM sessions WHERE id=?", req.sessionKey);
    const user =
      role === "admin"
        ? { id: "demo_admin", name: "Полный доступ", role: "admin" }
        : { ...teacher, role: "teacher" };
    session(res, { user, managementVersion });
    res.json({ user });
  });
  app.post("/api/logout", (req, res) => {
    if (req.sessionKey) run("DELETE FROM sessions WHERE id=?", req.sessionKey);
    res.clearCookie("journal", { path: "/" });
    res.json({ ok: true });
  });
  let oidcConfig;
  async function config() {
    if (!process.env.OIDC_ISSUER || !process.env.OIDC_CLIENT_ID)
      throw fail(
        503,
        "Вход ВШЭ ещё не подключён. Учебному офису необходимо зарегистрировать приложение у провайдера авторизации.",
      );
    return (oidcConfig ??= await oidc.discovery(
      new URL(process.env.OIDC_ISSUER),
      process.env.OIDC_CLIENT_ID,
      process.env.OIDC_CLIENT_SECRET,
    ));
  }
  app.get("/auth/login", async (req, res) => {
    if (selection) return res.redirect("/");
    const c = await config(),
      verifier = oidc.randomPKCECodeVerifier(),
      state = oidc.randomState(),
      nonce = oidc.randomNonce();
    session(res, { verifier, state, nonce, created: Date.now() });
    res.redirect(
      oidc.buildAuthorizationUrl(c, {
        redirect_uri: origin + "/auth/callback",
        scope: "openid email profile",
        code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
        code_challenge_method: "S256",
        state,
        nonce,
      }).href,
    );
  });
  app.get("/auth/callback", async (req, res) => {
    const s = req.session;
    if (!s?.verifier || Date.now() - s.created > 600000)
      throw fail(401, "Время входа истекло. Повторите вход.");
    run("DELETE FROM sessions WHERE id=?", req.sessionKey);
    const t = await oidc.authorizationCodeGrant(
      await config(),
      new URL(req.originalUrl, origin),
      {
        pkceCodeVerifier: s.verifier,
        expectedState: s.state,
        expectedNonce: s.nonce,
        idTokenExpected: true,
      },
    );
    const claims = t.claims();
    const email = String(claims.email || "").toLowerCase();
    const account = accounts.find(
      (a) => a.email.toLowerCase() === email && a.subject === claims.sub,
    );
    if (!account) {
      // Студенты входят по @edu.hse.ru – проверка домена почты им не требуется.
      const studentId = studentByExternalId(claims.sub);
      const student =
        studentId && roster.students.find((s) => s.id === studentId);
      // Студент попадает на экран входа с объяснением, а не на голый JSON.
      if (!student) return res.redirect("/?error=unlinked");
      if (!cabinetOpen(studentId)) return res.redirect("/?error=closed");
      session(res, {
        user: {
          id: studentId,
          name: student.name,
          role: "student",
          studentId,
          source: "oidc",
          subject: claims.sub,
        },
      });
      return res.redirect("/");
    }
    if (
      claims.email_verified !== true ||
      !email.endsWith("@hse.ru") ||
      !["admin", "teacher"].includes(account.role)
    )
      throw fail(
        403,
        "Учётная запись не подключена к журналу. Обратитесь в учебный офис.",
      );
    if (
      account.role === "teacher" &&
      !roster.teachers.some((t) => t.id === account.teacherId)
    )
      throw fail(403, "Преподаватель не сопоставлен с базой");
    session(res, {
      user: {
        id: account.teacherId || account.subject,
        name: account.name,
        email,
        role: account.role,
        source: "explicit",
        subject: claims.sub,
      },
    });
    res.redirect("/");
  });
  return { auth, admin };
}
