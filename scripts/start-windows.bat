@echo off
setlocal
cd /d "%~dp0.."
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node.js 22.5 or newer, then try again.
  pause
  exit /b 1
)
start "Yatzy Engine" /min cmd /c "npm start"
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:4317"
endlocal
