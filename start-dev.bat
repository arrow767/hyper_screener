@echo off
echo ============================================================
echo   Starting Hyperliquid Screener (Development Mode)
echo ============================================================
echo.

if not exist .env (
    echo ERROR: .env file not found!
    echo Please copy env.example to .env and configure it.
    echo.
    echo Run: copy env.example .env
    echo.
    pause
    exit /b 1
)

if not exist node_modules (
    echo Installing dependencies...
    call npm install
    echo.
)

echo Starting monitor in development mode...
echo Press Ctrl+C to stop
echo.
call npm run dev

