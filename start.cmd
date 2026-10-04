@echo off
setlocal
cd /d "%~dp0"
if defined MOON_HOME set "PATH=%MOON_HOME%\bin;%PATH%"
where moon >nul 2>nul
if errorlevel 1 if exist "%USERPROFILE%\.moon\bin\moon.exe" set "PATH=%USERPROFILE%\.moon\bin;%PATH%"
node scripts\build.mjs
if errorlevel 1 goto failed
node scripts\launch.mjs
if errorlevel 1 goto failed
exit /b 0
:failed
echo Unable to start. Check the messages above and the README.
pause
exit /b 1
