# SRBMiner Dashboard

Lightweight, high-performance web dashboard for SRBMiner-MULTI. Launches the miner, streams live colorized logs, and displays real-time telemetry (multi-algorithm, CPU threads, AMD/NVIDIA/Intel GPUs, pool latency, shares, and difficulty) over Server-Sent Events (SSE).

## Prerequisites

- Windows or Linux
- Node.js 18+ available as `node`
- SRBMiner-MULTI placed in `../miner` or configured via `MINER_CWD` / `MINER_EXE`

## Setup

- Ensure SRBMiner-MULTI is available in the miner folder.
- Create your `.env` by copying the example file:

  ```powershell
  Copy-Item -Path ".env.example" -Destination ".env"
  ```

  ```bat
  copy .env.example .env
  ```

- Open `.env` in a text editor and fill in your values. All available options are documented in `.env.example`.

## Environment Variables

The dashboard uses a `.env` file (or OS environment variables) for configuration. In addition to the required miner arguments, you can set the following optional flags:

- **`FORWARD_CONSOLE`** (default `false`): When `true`, mirrors the SRBMiner stdout/stderr to the terminal where `main.js` is running, regardless of whether any browser tabs are open. When `false` or unset, nothing from the miner is printed to the Node console; the dashboard still parses and shows the logs. Parsed case-insensitively (e.g. `True`, `true`).

## Start

```bat
node main.js
```

Open `http://127.0.0.1:4067` (or your LAN IP if you configured `HOST=0.0.0.0`) and enter your passphrase (if configured).

## Project structure

```plain
main.js                   entry point (node main.js)
server/                   Node.js application runtime
  utils/                  shared foundations: args, config, constants, state, timers
  http/                   HTTP subsystem: auth, bundle, http, ratelimit, sse, static
  miner/                  miner process + hardware: devices, gpu, miner, parser
web/                      browser-facing web application
  index.html              document template
  style.css               stylesheet
  favicon.svg             favicon
  services/               bootstrap + infrastructure: app, connection, perf
  components/             UI components: console, gpu, identity, metric, modal, toast
  lib/                    shared utilities: dom, present, user
```

Delivery follows a three-layer model: the `web/` source is composed at startup into a single bundle and served through an explicit allowlist (`/`, `/index.html`, `/app.js`, `/style.css`, `/favicon.svg`). Internal paths such as `/js/*`, `/server/*`, `/web/*` and any traversal are never resolvable over HTTP.

## Resource footprint

Measured on Node 22 (Linux x86-64, 2 cores): **~0.08% CPU idle**, **~0.2% CPU** with one browser tab streaming. The dashboard's own heap is **~6–8 MB**; the rest of the process RSS is the Node runtime (~41 MB floor), so a plain `node main.js` idles around **54 MB**.

`nvidia-smi` is only queried (read-only) while a browser tab is open.

Optional lean launch (saves ~6 MB RSS):

```bat
set UV_THREADPOOL_SIZE=2
node --jitless --max-semi-space-size=4 --max-old-space-size=32 main.js
```
