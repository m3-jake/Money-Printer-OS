@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -File "%~dp0Install-Windows.ps1"
if errorlevel 1 (echo. & echo Installation was not completed. Review the message above.)
pause
