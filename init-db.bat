@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo ============================================================
echo   碳链通 CarbonChain Hub —— 数据库一键初始化
echo ------------------------------------------------------------
echo   本操作会 DROP 并重建 carbon_chain 库，然后：
echo     1) 建 22 张表
echo     2) 生成全部仿真数据（业务表每表 50 行以上）
echo     3) 登记联盟成员节点，真实执行 ECDSA 签名与 PoA 授权出块，构建联盟链
echo     4) 自举碳资产动态核算（CEMS 实测读数 + 滚动核算）
echo   预计耗时 5~15 秒，请勿中途关闭窗口。
echo ============================================================
echo.

if "%DB_PASSWORD%"=="" (
  echo [提示] 未设置 DB_PASSWORD 环境变量，将使用默认口令 123456
  echo        若你的 MySQL 口令不同，请先执行： set DB_PASSWORD=你的口令
  echo.
)

node -v >nul 2>&1
if errorlevel 1 (
  echo [错误] 未检测到 node，请先安装 Node.js 18 及以上版本并加入 PATH。
  pause
  exit /b 1
)

node server/scripts/init-db.js
set RC=%ERRORLEVEL%

echo.
if "%RC%"=="0" (
  echo ============================================================
  echo   ^✅ 初始化完成，可以双击 start.bat 启动服务了
  echo ============================================================
) else (
  echo ============================================================
  echo   ^❌ 初始化失败，错误码 %RC%，请查看上方日志
  echo   常见原因：MySQL 未启动 / 口令不对 / 端口不是 3306
  echo ============================================================
)
echo.
pause
exit /b %RC%
