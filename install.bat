@echo off
rem Journal installer for Windows: checks Node.js 24 and starts the shared
rem installer (scripts\installer). Same questions as install.sh on Linux/macOS.
rem ASCII only in this file: cmd.exe misreads non-ASCII text in .bat files.
setlocal
cd /d "%~dp0"
chcp 65001 >nul
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 24 or newer is required: https://nodejs.org/
  pause
  exit /b 1
)
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 24 ? 0 : 1)"
if errorlevel 1 (
  echo Node.js 24 or newer is required: https://nodejs.org/
  pause
  exit /b 1
)
node scripts\installer\main.mjs %*
set CODE=%ERRORLEVEL%
if not "%CODE%"=="0" pause
exit /b %CODE%
