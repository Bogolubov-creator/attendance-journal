#!/usr/bin/env bash
# Установка журнала на Linux: через Docker (приложение + Caddy с HTTPS) или
# напрямую (Node.js 24 + служба systemd, HTTPS даёт уже стоящий прокси).
#   ./scripts/install.sh            – спросит способ
#   ./scripts/install.sh --docker   – через Docker
#   ./scripts/install.sh --native   – без Docker
# Запускать из папки журнала обычным пользователем с правом sudo.
# Повторный запуск безопасен: существующий .env и данные не затираются без вопроса.
set -euo pipefail

APP_PORT=3100
SERVICE=attendance-journal

say() { printf '\n== %s\n' "$*"; }
fail() {
  printf '\nОшибка: %s\n' "$*" >&2
  exit 1
}
ask() { # ask "Вопрос" "по умолчанию" → ответ в REPLY
  local prompt="$1" default="${2:-}"
  if [[ -n "$default" ]]; then
    read -r -p "$prompt [$default]: " REPLY
    REPLY="${REPLY:-$default}"
  else
    read -r -p "$prompt: " REPLY
  fi
}
yes_no() { # yes_no "Вопрос" → код 0 при «да»
  read -r -p "$1 [д/н]: " REPLY
  [[ "$REPLY" =~ ^[ДдYy] ]]
}

# Строка KEY=value в .env: заменить, если есть, иначе дописать.
set_env() {
  local key="$1" value="$2" file="${3:-.env}"
  if grep -q "^${key}=" "$file"; then
    local tmp
    tmp="$(mktemp)"
    awk -v k="$key" -v v="$value" 'BEGIN { FS = OFS = "=" }
      $1 == k { print k "=" v; next } { print }' "$file" >"$tmp"
    cat "$tmp" >"$file"
    rm -f "$tmp"
  else
    printf '%s=%s\n' "$key" "$value" >>"$file"
  fi
}

check_domain() {
  [[ "$1" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ && "$1" == *.* ]] ||
    fail "«$1» не похоже на доменное имя (пример: journal.pravo.hse.ru)"
}

# Хеш общего пароля (вход по общему паролю до дня переключения).
# Пустой пароль – вход по общему паролю закрыт, остаются личные пароли.
password_hash() {
  local runner=("$@")
  say "Общий пароль журнала"
  echo "Нужен только на время перехода: до включения входа по личным паролям."
  echo "Оставьте пустым, если сразу работаете по личным паролям."
  local line
  # tr: при запуске через docker -t строки приходят с \r.
  line="$("${runner[@]}" scripts/password-hash.mjs | tr -d '\r' || true)"
  if [[ "$line" == MANAGEMENT_PASSWORD_HASH=* ]]; then
    set_env MANAGEMENT_PASSWORD_HASH "${line#MANAGEMENT_PASSWORD_HASH=}"
  else
    set_env MANAGEMENT_PASSWORD_HASH ""
    echo "Общий пароль не задан: вход только по личным паролям."
  fi
}

# .env из шаблона: общие значения для обоих способов.
prepare_env() {
  local mode="$1"
  if [[ -f .env ]]; then
    if ! yes_no "Файл .env уже есть. Заполнить его заново (данные не пострадают)?"; then
      say "Оставляю прежний .env"
      return 1
    fi
  fi
  # Домен спрашивается до перезаписи: при опечатке прежний .env остаётся.
  ask "Адрес сайта без https:// (например, journal.pravo.hse.ru)"
  local domain="$REPLY"
  check_domain "$domain"
  [[ ! -f .env ]] || cp .env ".env.bak.$(date +%Y%m%d-%H%M%S)"
  cp .env.example .env
  chmod 600 .env
  set_env DOMAIN "$domain"
  set_env APP_ORIGIN "https://$domain"
  set_env DEMO_MODE false
  set_env DATA_MODE live
  set_env AUTH_MODE selection
  set_env AUTO_BACKUP true
  set_env BACKUP_KEEP 14
  set_env TRUST_PROXY 1
  if [[ "$mode" == native ]]; then
    set_env HOST 127.0.0.1
    set_env PORT "$APP_PORT"
    set_env BACKUP_DIR data/backups
    set_env UPLOAD_DIR data/uploads
  fi
  return 0
}

install_docker() {
  say "Установка через Docker"
  command -v docker >/dev/null || fail "Docker не найден. Установите Docker Engine: https://docs.docker.com/engine/install/"
  docker compose version >/dev/null 2>&1 || fail "Нет docker compose (плагин Compose v2)."
  docker info >/dev/null 2>&1 || fail "Docker не запущен или у пользователя нет к нему доступа (группа docker или sudo)."

  if prepare_env docker; then
    password_hash docker run --rm -it -v "$PWD:/app" -w /app node:24-bookworm-slim node
  fi
  domain="$(grep '^DOMAIN=' .env | cut -d= -f2-)"

  say "Папки данных (владелец – пользователь контейнера, UID 1000)"
  mkdir -p data backups uploads
  sudo chown -R 1000:1000 data backups uploads
  sudo chmod 700 data backups uploads

  say "Проверка и запуск"
  docker compose config --quiet
  docker compose up -d --build
  echo "Жду, пока приложение станет здоровым…"
  for _ in $(seq 1 30); do
    if [[ "$(docker compose ps --format '{{.Health}}' app 2>/dev/null)" == healthy ]]; then
      break
    fi
    sleep 2
  done
  docker compose ps

  say "Готово"
  cat <<EOF
Сайт: https://$domain (сертификат Caddy получает сам; домен должен указывать на этот сервер,
порты 80 и 443 открыты).

Первый вход администратора журнала:
  docker compose exec app node scripts/invite-admin.mjs gadzhieva
– скрипт напечатает логин и код; на сайте «Первый вход по коду приглашения».

Журнал приложения:   docker compose logs --tail=100 app
Обновление:          git pull && docker compose up -d --build
EOF
}

install_native() {
  say "Установка без Docker"
  [[ "$(uname -s)" == Linux ]] || fail "Скрипт рассчитан на Linux. Для Windows – scripts/install.ps1."
  command -v node >/dev/null || fail "Нет Node.js. Установите Node.js 24: https://nodejs.org/ (или пакеты NodeSource)."
  local major
  major="$(node -p 'process.versions.node.split(".")[0]')"
  ((major >= 24)) || fail "Нужен Node.js 24 или новее, сейчас $(node -v)."
  command -v systemctl >/dev/null || fail "Нет systemd: запускайте журнал вручную или используйте --docker."

  say "Зависимости"
  npm ci --omit=dev

  if prepare_env native; then
    password_hash node
  fi
  domain="$(grep '^DOMAIN=' .env | cut -d= -f2-)"

  say "Папки данных"
  mkdir -p data/backups data/uploads
  chmod 700 data
  chmod 600 .env

  say "Служба systemd: $SERVICE"
  local user dir node_bin
  user="$(id -un)"
  dir="$PWD"
  node_bin="$(command -v node)"
  sudo tee "/etc/systemd/system/$SERVICE.service" >/dev/null <<EOF
[Unit]
Description=Журнал посещаемости иностранных студентов
After=network.target

[Service]
User=$user
WorkingDirectory=$dir
ExecStart=$node_bin --env-file=$dir/.env src/server.js
Restart=on-failure
RestartSec=5
TimeoutStopSec=35
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=$dir/data

[Install]
WantedBy=multi-user.target
EOF
  sudo systemctl daemon-reload
  sudo systemctl enable --now "$SERVICE"
  sudo systemctl restart "$SERVICE"

  echo "Проверяю /healthz…"
  local ok=""
  for _ in $(seq 1 15); do
    if curl -fsS -H "Host: $domain" "http://127.0.0.1:$APP_PORT/healthz" >/dev/null 2>&1; then
      ok=1
      break
    fi
    sleep 1
  done
  [[ -n "$ok" ]] || fail "Журнал не ответил. Смотрите: sudo journalctl -u $SERVICE -n 50"

  say "Готово"
  cat <<EOF
Журнал слушает 127.0.0.1:$APP_PORT. Снаружи он должен открываться только через HTTPS-прокси
на домене $domain, который передаёт заголовок Host без изменений. Пример для nginx:

  server {
    listen 443 ssl;
    server_name $domain;
    # ssl_certificate / ssl_certificate_key – сертификат домена
    client_max_body_size 30m;
    location / {
      proxy_pass http://127.0.0.1:$APP_PORT;
      proxy_set_header Host \$host;
      proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    }
  }

Первый вход администратора журнала:
  node scripts/invite-admin.mjs gadzhieva

Состояние службы:  sudo systemctl status $SERVICE
Журнал службы:     sudo journalctl -u $SERVICE -n 100
Обновление:        git pull && npm ci --omit=dev && sudo systemctl restart $SERVICE
EOF
}

main() {
  cd "$(dirname "$0")/.."
  [[ -f src/server.js && -f .env.example ]] || fail "Запускайте из папки журнала (нет src/server.js)."
  [[ $EUID -ne 0 ]] || fail "Запускайте обычным пользователем с правом sudo, не от root."
  local mode="${1:-}"
  case "$mode" in
  --docker) install_docker ;;
  --native) install_native ;;
  "")
    echo "Как установить журнал?"
    echo "  1 – через Docker: приложение и Caddy, HTTPS-сертификат получается сам"
    echo "  2 – без Docker: Node.js 24 и служба systemd, HTTPS даёт ваш прокси"
    ask "Выберите 1 или 2" 1
    case "$REPLY" in
    1) install_docker ;;
    2) install_native ;;
    *) fail "Ожидался ответ 1 или 2" ;;
    esac
    ;;
  *) fail "Неизвестный ключ $mode. Допустимо: --docker, --native" ;;
  esac
}

# Функции можно подключить в тестах через source, не запуская установку.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
