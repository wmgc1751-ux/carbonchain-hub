@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo ============================================================
echo   碳链通 CarbonChain Hub —— 服务启动
echo ------------------------------------------------------------
echo   若这是第一次运行，请先双击 init-db.bat 初始化数据库。
echo   启动后请在浏览器访问： http://localhost:8300
echo   演示账号： ent001 / ver001 / reg001 / admin   口令见 README
echo   按 Ctrl+C 可停止服务。
echo ============================================================
echo.

node -v >nul 2>&1
if errorlevel 1 (
  echo [错误] 未检测到 node，请先安装 Node.js 18 及以上版本并加入 PATH。
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo [提示] 未发现 node_modules，正在安装依赖……
  call npm install
  if errorlevel 1 (
    echo [错误] 依赖安装失败，请检查网络后重试。
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
  echo   ^❌ 服务退出，错误码 %RC%
  echo   常见原因：数据库未初始化（先跑 init-db.bat）/ 8300 端口被占用
  echo   换端口： set PORT=8400  然后重新双击本文件
  echo ============================================================
  pause
)
exit /b %RC%
