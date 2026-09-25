# Прежняя команда установки на Windows: теперь это обёртка над общим установщиком
# (scripts\installer). -Docker / -Native – этот компьютер через Docker / без него.
#   powershell -ExecutionPolicy Bypass -File scripts\install.ps1 [-Docker | -Native]
# Для установки без Docker запускайте PowerShell «от имени администратора».
# Файл в UTF-8 с BOM: иначе Windows PowerShell 5.1 искажает русский текст.
param([switch]$Docker, [switch]$Native)

$root = Split-Path -Parent $PSScriptRoot
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host 'Нужен Node.js 24 или новее: https://nodejs.org/' -ForegroundColor Red
  exit 1
}
# Двойные кавычки внутри аргумента Windows PowerShell 5.1 теряет – здесь только одинарные.
$major = [int](node -p "process.versions.node.split('.')[0]")
if ($major -lt 24) {
  Write-Host "Нужен Node.js 24 или новее, сейчас $(node -v): https://nodejs.org/" -ForegroundColor Red
  exit 1
}
$arguments = @(Join-Path $root 'scripts\installer\main.mjs')
if ($Docker) { $arguments += '--docker' }
if ($Native) { $arguments += '--native' }
& node @arguments
exit $LASTEXITCODE
