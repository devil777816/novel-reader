@echo off
chcp 65001 >nul 2>&1
setlocal
cd /d "%~dp0"

set "PORT=8080"

echo ========================================
echo   纯净阅读 - 本地测试服务器
echo ========================================
echo.

REM ---- 查找局域网 IPv4 ----
set "LANIP="
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do (
    if not defined LANIP set "LANIP=%%a"
)
if defined LANIP set "LANIP=%LANIP: =%"

echo   电脑访问:  http://localhost:%PORT%
if defined LANIP echo   手机访问:  http://%LANIP%:%PORT%
echo.
echo   按 Ctrl+C 可停止服务器
echo ========================================
echo.

REM ---- 选择一个可用的服务器程序 ----
REM 优先用 serve.py：它会加 no-store，手机不会拿到旧版本。
REM 注意 HTTP 访问下 Service Worker 不生效，缓存完全由浏览器 HTTP 缓存决定，
REM 这就是以前改了代码却"刷新也没用"的原因。
set "SRV="

if exist "%~dp0serve.py" (
    where python >nul 2>nul
    if not errorlevel 1 set SRV=python "%~dp0serve.py" %PORT%
)

if not defined SRV (
    if exist "%~dp0serve.py" (
        where py >nul 2>nul
        if not errorlevel 1 set SRV=py "%~dp0serve.py" %PORT%
    )
)

REM 退路：没有 serve.py 就退回内置服务器（会缓存，可能拿到旧版本）
if not defined SRV (
    where python >nul 2>nul
    if not errorlevel 1 set "SRV=python -m http.server %PORT%"
)

if not defined SRV (
    where py >nul 2>nul
    if not errorlevel 1 set "SRV=py -m http.server %PORT%"
)

if not defined SRV (
    where npx >nul 2>nul
    if not errorlevel 1 set "SRV=npx --yes serve . -l %PORT%"
)

if not defined SRV (
    echo   [错误] 没有找到 Python 或 Node.js。
    echo.
    echo   请先安装其中一个：
    echo     Python  https://www.python.org/downloads/
    echo     Node.js https://nodejs.org/
    echo.
    pause
    exit /b 1
)

echo   [启动] %SRV%
echo.

%SRV%

echo.
echo   [已停止] 服务器已退出。
pause