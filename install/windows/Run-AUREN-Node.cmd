@echo off
rem Double-click to run an AUREN node on Windows. Needs Node.js 20+ (Install-AUREN.ps1 can install it for you).
title AUREN node
cd /d "%~dp0..\.."
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20 or newer is not installed.
  echo Right-click Install-AUREN.ps1 and choose "Run with PowerShell", or install it from https://nodejs.org
  pause
  exit /b 1
)
echo.
echo  AUREN node
echo  ----------
echo  1) Testnet   (free test coins, recommended)
echo  2) Devnet
echo  3) Mainnet   (not launched yet)
echo.
set /p CHOICE=Which network do you want to join? [1]:
if "%CHOICE%"=="" set CHOICE=1
set NET=testnet
if "%CHOICE%"=="2" set NET=devnet
if "%CHOICE%"=="3" set NET=mainnet
node bin\auren.js join %NET%
echo.
pause
