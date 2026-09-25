@echo off
setlocal
title Robinhood API key pair
set "REPO=W:\money-printer-os"
set "OUT=%USERPROFILE%\OneDrive\Desktop\Robinhood-API-Keys.txt"
if not exist "%USERPROFILE%\OneDrive\Desktop" set "OUT=%USERPROFILE%\Desktop\Robinhood-API-Keys.txt"
set "NODE=node"
where node >nul 2>&1 || set "NODE=C:\Program Files\nodejs\node.exe"
echo.
echo Making a new Robinhood API key pair...
echo.
"%NODE%" "%REPO%\scripts\robinhood-keygen.mjs" > "%OUT%" 2>&1
if errorlevel 1 (
  echo Something went wrong. The message is in: %OUT%
  type "%OUT%"
  pause
  exit /b 1
)
type "%OUT%"
echo.
echo Saved to: %OUT%
echo.
echo NEXT:
echo   1. Open robinhood.com/account/crypto  ^>  API Trading  ^>  Add key
echo   2. Paste the PUBLIC KEY from the file. Robinhood then shows you an API KEY - copy it.
echo   3. In Money Printer OS, Robinhood panel  ^>  Connection and safety  ^>  CONFIGURE:
echo      paste the API KEY and the PRIVATE SEED from the file. Leave "enable real" off.
echo   4. Delete the text file when you are done. Never send it to anyone.
echo.
start "" notepad "%OUT%"
pause
