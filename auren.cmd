@echo off
rem AUREN launcher for Windows. Needs only Node.js 20+ (https://nodejs.org). No npm, no install step.
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20 or newer is required: https://nodejs.org
  exit /b 1
)
node "%~dp0bin\auren.js" %*
