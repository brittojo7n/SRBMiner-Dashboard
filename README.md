# SRBMiner Dashboard

Lightweight web dashboard for SRBMiner-MULTI. Launches the miner, streams live logs, and shows GPU telemetry.

## Prerequisites

- Operating System: Windows
- For Telemetry only NVIDIA GPUs are Supported: `nvidia-smi` on PATH (only required if you want to see GPU telemetry)
- Node.js 18+
- SRBMiner-MULTI downloaded separately.

## Setup & Run

1. Copy `.env.example` to `.env` and configure your settings.
2. Start the dashboard:

    ```bat
    node main.js
    ```

    Optionally you can define a batch file to run the dashboard with elevated privileges and set the thread pool size for Node.js.

    Example `start.bat`:

    ```bat
    @echo off
    setlocal

    fltmc >nul 2>&1
    if not "%errorlevel%"=="0" (
        powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
        exit /b
    )

    cd /d "%~dp0"

    set UV_THREADPOOL_SIZE=2
    node --jitless --max-semi-space-size=4 --max-old-space-size=32 main.js
    pause
    ```

3. Open `http://127.0.0.1:4067` (or your LAN IP if you had given `0.0.0.0` as the IP) and enter the passphrase (if you have set one).

## Structure

- `main.js`: Application entrypoint
- `server/`: HTTP server, auth, SSE hub, miner process manager, hardware telemetry
- `web/`: Client UI, components, live event connection, responsive styling
