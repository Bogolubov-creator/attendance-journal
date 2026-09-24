# Установка журнала на Windows: через Docker Desktop (приложение + Caddy с HTTPS) или
# напрямую (Node.js 24 + задача планировщика при старте системы, HTTPS даёт ваш прокси).
#   powershell -ExecutionPolicy Bypass -File scripts\install.ps1            – спросит способ
#   powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -Docker    – через Docker
#   powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -Native    – без Docker
# Запускать из PowerShell «от имени администратора».
# Повторный запуск безопасен: существующий .env и данные не затираются без вопроса.
# Файл сохранён в UTF-8 с BOM: иначе Windows PowerShell 5.1 искажает русский текст.
param([switch]$Docker, [switch]$Native)

$ErrorActionPreference = 'Stop'
$AppPort = 3100
$TaskName = 'AttendanceJournal'

function Say($text) { Write-Host "`n== $text" -ForegroundColor Cyan }
function Fail($text) {
  Write-Host "`nОшибка: $text" -ForegroundColor Red
  exit 1
}
function Ask($prompt, $default = '') {
  $suffix = if ($default) { " [$default]" } else { '' }
  $answer = Read-Host "$prompt$suffix"
  if (-not $answer) { $answer = $default }
  return $answer
}
function YesNo($prompt) { return (Read-Host "$prompt [д/н]") -match '^[ДдYy]' }
# Внешняя программа без вывода; возвращает код выхода. В Windows PowerShell 5.1
# перенаправленный stderr внешней программы при ErrorActionPreference=Stop
# превращается в исключение, поэтому на время вызова – Continue.
function Invoke-Quiet([scriptblock]$command) {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $command *> $null } finally { $ErrorActionPreference = $previous }
  return $LASTEXITCODE
}

# .env пишется в UTF-8 без BOM: Node.js читает его через --env-file.
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
function Set-EnvValue($key, $value) {
  $path = Join-Path $PWD '.env'
  $lines = [System.Collections.Generic.List[string]]([IO.File]::ReadAllLines($path, $Utf8NoBom))
  $index = $lines.FindIndex({ param($l) $l.StartsWith("$key=") })
  if ($index -ge 0) { $lines[$index] = "$key=$value" } else { $lines.Add("$key=$value") }
  [IO.File]::WriteAllLines($path, $lines, $Utf8NoBom)
}
function Get-EnvValue($key) {
  $line = [IO.File]::ReadAllLines((Join-Path $PWD '.env'), $Utf8NoBom) |
    Where-Object { $_.StartsWith("$key=") } | Select-Object -First 1
  if ($line) { return $line.Substring($key.Length + 1) }
  return ''
}
function Assert-Domain($domain) {
  if ($domain -notmatch '^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$' -or $domain -notlike '*.*') {
    Fail "«$domain» не похоже на доменное имя (пример: journal.pravo.hse.ru)"
  }
}

# Хеш общего пароля (вход по общему паролю до дня переключения).
# Пустой пароль – вход по общему паролю закрыт, остаются личные пароли.
function Set-SharedPassword([scriptblock]$runHashScript) {
  Say 'Общий пароль журнала'
  Write-Host 'Нужен только на время перехода: до включения входа по личным паролям.'
  Write-Host 'Оставьте пустым, если сразу работаете по личным паролям.'
  $line = (& $runHashScript) -join '' -replace "`r", ''
  if ($line -like 'MANAGEMENT_PASSWORD_HASH=*') {
    Set-EnvValue 'MANAGEMENT_PASSWORD_HASH' $line.Substring('MANAGEMENT_PASSWORD_HASH='.Length)
  } else {
    Set-EnvValue 'MANAGEMENT_PASSWORD_HASH' ''
    Write-Host 'Общий пароль не задан: вход только по личным паролям.'
  }
}

# .env из шаблона; $false – пользователь оставил прежний файл.
function New-EnvFile($mode) {
  if (Test-Path .env) {
    if (-not (YesNo 'Файл .env уже есть. Заполнить его заново (данные не пострадают)?')) {
      Say 'Оставляю прежний .env'
      return $false
    }
  }
  # Домен спрашивается до перезаписи: при опечатке прежний .env остаётся.
  $domain = Ask 'Адрес сайта без https:// (например, journal.pravo.hse.ru)'
  Assert-Domain $domain
  if (Test-Path .env) { Copy-Item .env (".env.bak." + (Get-Date -Format 'yyyyMMdd-HHmmss')) }
  Copy-Item .env.example .env -Force
  Set-EnvValue 'DOMAIN' $domain
  Set-EnvValue 'APP_ORIGIN' "https://$domain"
  Set-EnvValue 'DEMO_MODE' 'false'
  Set-EnvValue 'DATA_MODE' 'live'
  Set-EnvValue 'AUTH_MODE' 'selection'
  Set-EnvValue 'AUTO_BACKUP' 'true'
  Set-EnvValue 'BACKUP_KEEP' '14'
  Set-EnvValue 'TRUST_PROXY' '1'
  if ($mode -eq 'native') {
    Set-EnvValue 'HOST' '127.0.0.1'
    Set-EnvValue 'PORT' "$AppPort"
    Set-EnvValue 'BACKUP_DIR' 'data/backups'
    Set-EnvValue 'UPLOAD_DIR' 'data/uploads'
  }
  return $true
}

# Доступ к базе, копиям, сканам и .env – только администраторам и системе.
function Protect-Path($path) {
  icacls $path /inheritance:r /grant:r 'SYSTEM:(OI)(CI)F' 'Administrators:(OI)(CI)F' "${env:USERNAME}:(OI)(CI)F" | Out-Null
}

function Install-Docker {
  Say 'Установка через Docker Desktop'
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Fail 'Docker не найден. Установите Docker Desktop: https://docs.docker.com/desktop/setup/install/windows-install/'
  }
  if ((Invoke-Quiet { docker compose version }) -ne 0) { Fail 'Нет docker compose (Compose v2).' }
  if ((Invoke-Quiet { docker info }) -ne 0) { Fail 'Docker Desktop не запущен. Запустите его и повторите.' }

  if (New-EnvFile 'docker') {
    Set-SharedPassword { docker run --rm -it -v "${PWD}:/app" -w /app node:24-bookworm-slim node scripts/password-hash.mjs }
  }
  $domain = Get-EnvValue 'DOMAIN'

  Say 'Папки данных'
  foreach ($dir in 'data', 'backups', 'uploads') {
    New-Item -ItemType Directory -Force $dir | Out-Null
    Protect-Path $dir
  }
  Protect-Path .env

  Say 'Проверка и запуск'
  docker compose config --quiet
  if ($LASTEXITCODE -ne 0) { Fail 'Ошибка в compose.yaml или .env.' }
  docker compose up -d --build
  if ($LASTEXITCODE -ne 0) { Fail 'Не удалось собрать или запустить контейнеры.' }
  Write-Host 'Жду, пока приложение станет здоровым…'
  foreach ($i in 1..30) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { $health = docker compose ps --format '{{.Health}}' app 2>$null } finally { $ErrorActionPreference = $previous }
    if ($health -eq 'healthy') { break }
    Start-Sleep -Seconds 2
  }
  docker compose ps

  Say 'Готово'
  Write-Host @"
Сайт: https://$domain (сертификат Caddy получает сам; домен должен указывать на этот
компьютер, порты 80 и 443 открыты в брандмауэре Windows).

Первый вход администратора журнала:
  docker compose exec app node scripts/invite-admin.mjs gadzhieva
– скрипт напечатает логин и код; на сайте «Первый вход по коду приглашения».

Журнал приложения:   docker compose logs --tail=100 app
Обновление:          git pull; docker compose up -d --build
"@
}

function Stop-Journal {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  }
  # Задача запускает cmd, а он – node: процесс node останавливается отдельно.
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like '*src\server.js*' -or $_.CommandLine -like '*src/server.js*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
}

function Install-Native {
  Say 'Установка без Docker'
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { Fail 'Нет Node.js. Установите Node.js 24 LTS: https://nodejs.org/' }
  # Двойные кавычки внутри аргумента Windows PowerShell 5.1 теряет – здесь только одинарные.
  $major = [int](node -p "process.versions.node.split('.')[0]")
  if ($major -lt 24) { Fail "Нужен Node.js 24 или новее, сейчас $(node -v)." }

  Say 'Зависимости'
  npm ci --omit=dev
  if ($LASTEXITCODE -ne 0) { Fail 'npm ci завершился с ошибкой.' }

  if (New-EnvFile 'native') { Set-SharedPassword { node scripts/password-hash.mjs } }
  $domain = Get-EnvValue 'DOMAIN'

  Say 'Папки данных'
  foreach ($dir in 'data', 'data\backups', 'data\uploads') { New-Item -ItemType Directory -Force $dir | Out-Null }
  Protect-Path data
  Protect-Path .env

  Say "Задача планировщика: $TaskName (запуск при старте системы)"
  $dir = (Get-Location).Path
  $start = Join-Path $dir 'data\start-journal.cmd'
  [IO.File]::WriteAllLines($start, @(
      '@echo off',
      "cd /d `"$dir`"",
      "`"$($node.Source)`" --env-file=.env src\server.js >> data\server.log 2>&1"
    ), (New-Object System.Text.UTF8Encoding($false)))
  Stop-Journal
  $action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$start`""
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings -Force | Out-Null
  Start-ScheduledTask -TaskName $TaskName

  Write-Host 'Проверяю /healthz…'
  $ok = $false
  foreach ($i in 1..15) {
    if ((Invoke-Quiet { curl.exe -fsS -H "Host: $domain" "http://127.0.0.1:$AppPort/healthz" }) -eq 0) {
      $ok = $true
      break
    }
    Start-Sleep -Seconds 1
  }
  if (-not $ok) { Fail "Журнал не ответил. Смотрите data\server.log" }

  Say 'Готово'
  Write-Host @"
Журнал слушает 127.0.0.1:$AppPort. Снаружи он должен открываться только через HTTPS-прокси
на домене $domain, который передаёт заголовок Host без изменений. Проще всего – Caddy
для Windows (https://caddyserver.com/download), файл Caddyfile:

  $domain {
    reverse_proxy 127.0.0.1:$AppPort
  }

Первый вход администратора журнала:
  node scripts\invite-admin.mjs gadzhieva

Журнал сервера:  data\server.log
Перезапуск:      Stop-ScheduledTask $TaskName; Start-ScheduledTask $TaskName
                 (или снова этот скрипт – он остановит прежний процесс)
Обновление:      git pull; npm ci --omit=dev; затем снова этот скрипт с -Native
"@
}

Set-Location (Split-Path -Parent $PSScriptRoot)
if (-not (Test-Path src\server.js) -or -not (Test-Path .env.example)) {
  Fail 'Запускайте из папки журнала (нет src\server.js).'
}
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).
  IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { Fail 'Запустите PowerShell «от имени администратора».' }

if ($Docker) { Install-Docker }
elseif ($Native) { Install-Native }
else {
  Write-Host 'Как установить журнал?'
  Write-Host '  1 – через Docker Desktop: приложение и Caddy, HTTPS-сертификат получается сам'
  Write-Host '  2 – без Docker: Node.js 24 и задача планировщика, HTTPS даёт ваш прокси'
  switch (Ask 'Выберите 1 или 2' '1') {
    '1' { Install-Docker }
    '2' { Install-Native }
    default { Fail 'Ожидался ответ 1 или 2' }
  }
}
