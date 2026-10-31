@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo ============================================================
echo   CarbonChain Hub - service launcher
echo ------------------------------------------------------------
echo   First run: double-click init-db.bat to create the database.
echo   Then open:  http://localhost:8300
echo   Demo accounts (password 123456):
echo     ent_zjbd  ent_yfkw  ent_yxyf  ent_zjyls   ^<- 4 real plants (one each)
echo     reg001  ver_cz_review  trader01  admin(admin123)
echo   Press Ctrl+C to stop the service.
echo ============================================================
echo.

REM The ledger runs on a SEPARATE mysqld instance (port 3307).
REM Without it /api/health returns ECONNREFUSED and the whole site is 500,
REM so bring it up first and wait until the port is actually listening.
if not exist "D:\MySQL\start-ledger.bat" goto :ledger_skip
call "D:\MySQL\start-ledger.bat"
set /a LN=0
:ledger_wait
netstat -an | findstr /C:"127.0.0.1:3307" | findstr /C:"LISTENING" >nul 2>&1
if not errorlevel 1 goto :ledger_ok
set /a LN+=1
if %LN% GEQ 12 goto :ledger_slow
ping -n 2 127.0.0.1 >nul
goto :ledger_wait
:ledger_slow
echo [WARN] Ledger 3307 not ready after 24s - on-chain data will be unavailable.
goto :ledger_skip
:ledger_ok
echo [OK] Ledger 3307 is ready
:ledger_skip
echo.

node -v >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install Node 18+ and add it to PATH.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo [INFO] node_modules missing, running npm install ...
  call npm install
  if errorlevel 1 (
    echo [ERROR] npm install failed. Check the network and retry.
    pause
    exit /b 1
  )
  echo.
)

node server/app.js
set RC=%ERRORLEVEL%

echo.
if not "%RC%"=="0" (
  echo ============================================================
  echo   Service exited with code %RC%
  echo   Common causes: database not initialized (run init-db.bat),
  echo   port 8300 already in use, or ledger 3307 not reachable.
  echo   Change port:  set PORT=8400  then run this file again.
  echo ============================================================
  pause
)
exit /b %RC%
