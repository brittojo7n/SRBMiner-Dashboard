const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawn, execFile } = require("node:child_process");
const { parseMinerLine } = require("./parser");
const { STATUS, LOG, LIMITS } = require("../utils/constants");
const { parseCudaDeviceList, createStreamReader } = require("./devices");
const { unrefTimer: timer } = require("../utils/timers");

const SHELL_METACHAR_RE = /[;&|`$()\n\r<>]/;
const containsShellMetachars = (str) => SHELL_METACHAR_RE.test(str);

const ACTIONS = Object.freeze({
	start: STATUS.STARTING,
	stop: STATUS.STOPPING,
	restart: STATUS.RESTARTING,
});

const CLEAN_STATS = Object.freeze({
	hashrateKHs: null,
	accepted: 0,
	submitted: 0,
	rejected: 0,
	difficulty: null,
	lastAcceptedAt: null,
});

function resolveExe(exe, cwd) {
	if (!exe || containsShellMetachars(exe)) return null;
	const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
	if (path.isAbsolute(exe) && isFile(exe)) return exe;
	if (cwd) {
		const c = path.resolve(cwd, exe);
		if (isFile(c)) return c;
	}
	const root = path.resolve(__dirname, "..", "..");
	const cand = path.resolve(root, exe);
	if (isFile(cand)) return cand;
	return exe;
}

function sanitizeArgs(args) {
	return args.filter((a) => typeof a === "string" && !containsShellMetachars(a));
}

class MinerManager {
	constructor({ config, state, onUpdate, timeouts = {} }) {
		this.config = config;
		this.state = state;
		this.onUpdate = onUpdate;
		this.timeouts = {
			probe: timeouts.probe ?? LIMITS.PROBE_TIMEOUT_MS,
			forceKill: timeouts.forceKill ?? LIMITS.FORCE_KILL_MS,
			stop: timeouts.stop ?? LIMITS.STOP_TIMEOUT_MS,
			restartGap: timeouts.restartGap ?? LIMITS.RESTART_GAP_MS,
		};
		this.proc = null;
		this.isStoppingChild = false;
		this._stopPromise = null;
		this._forceKillTimer = null;
		this._actionTimer = null;
		this._pendingAction = null;
		this._statusRollback = null;
		this._spawning = false;
		this._probe = null;
		this._logServer = null;
		this._pushLogBound = (text, type) => this.pushLog(text, type);
	}

	_emit() {
		if (typeof this.onUpdate === "function") {
			try { this.onUpdate(); } catch {}
		}
	}

	_setMining(patch) {
		Object.assign(this.state.mining, patch);
		this.state.dirty = true;
	}

	_resetStats() {
		this._setMining({ ...CLEAN_STATS });
		this.state.mining.gpuHashrates = Object.create(null);
		this.state.mining.seenDevices = [];
	}

	_markDown(status, error) {
		this._spawning = false;
		this.isStoppingChild = false;
		this.state.miner.running = false;
		if (error) this.state.miner.lastError = error;
		this._setMining({ status });
		this._resetStats();
		if (this._logServer) {
			try { this._logServer.close(); } catch {}
			this._logServer = null;
		}
	}

	pushLog(text, type = LOG.INFO) {
		const logs = this.state.miner.logs;
		if (!logs) return;
		logs.push(text, type);
		this.state.miner.lastLine = text;
		this.state.dirty = true;
	}

	get _alive() {
		return Boolean(this.state.miner.running || this.proc || this._spawning);
	}

	start() {
		if (this._stopPromise) return this._stopPromise.then(() => this.start());
		if (this._alive) return Promise.resolve();

		this._resetStats();
		this.state.miner.lastError = "";
		const { MINER_ARGS, MINER_CWD } = this.config;
		if (!MINER_CWD || !MINER_ARGS.length) {
			const msg = `${MINER_CWD ? "MINER_ARGS" : "MINER_CWD"} not configured in .env`;
			this.state.miner.lastError = msg;
			this._setMining({ status: STATUS.STOPPED });
			this.pushLog(msg, LOG.WARN);
			this._emit();
			return Promise.resolve();
		}

		this._spawning = true;
		this._setMining({ status: STATUS.STARTING });
		this.pushLog("Starting miner...", LOG.SYSTEM);
		this._emit();

		return new Promise((resolve) => {
			this._probeDevices(() => {
				if (this._spawning) this._spawnMiner();
				resolve();
			});
		});
	}

	_probeDevices(done) {
		const { MINER_CWD } = this.config;
		const exe = resolveExe(this.config.MINER_EXE, MINER_CWD);
		if (!exe) {
			this._markDown(STATUS.CRASHED, "Invalid miner executable path");
			done();
			return;
		}
		let finished = false;
		let watchdog = null;
		const once = () => {
			if (finished) return;
			finished = true;
			clearTimeout(watchdog);
			this._probe = null;
			done();
		};

		let probe;
		try {
			probe = spawn(exe, ["--list-devices"], {
				cwd: MINER_CWD,
				windowsHide: true,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch {
			once();
			return;
		}

		this._probe = probe;
		let buf = "";
		const collect = (c) => { if (buf.length < LIMITS.STREAM_BUFFER_BYTES) buf += c; };
		probe.stdout.on("data", collect);
		probe.stderr.on("data", collect);
		probe.on("close", () => {
			try { parseCudaDeviceList(buf, this.state.mining.pciMap); } catch {}
			once();
		});
		probe.on("error", once);
		watchdog = timer(() => {
			if (finished) return;
			this.pushLog("Device probe timed out; continuing without PCI mapping.", LOG.WARN);
			try { probe.kill("SIGKILL"); } catch {}
			once();
		}, this.timeouts.probe);
	}

	_spawnMiner() {
		const { MINER_ARGS, MINER_CWD, FORWARD_CONSOLE } = this.config;
		const exe = resolveExe(this.config.MINER_EXE, MINER_CWD);
		if (!exe) {
			this._markDown(STATUS.CRASHED, "Invalid miner executable path");
			this._emit();
			return;
		}
		const safeArgs = sanitizeArgs(MINER_ARGS);
		if (this._logServer) {
			try { this._logServer.close(); } catch {}
			this._logServer = null;
		}

		const isWin = process.platform === "win32";

		const doSpawn = () => {
			if (!this._spawning) return;
			try {
				this.proc = spawn(exe, safeArgs, {
					cwd: MINER_CWD,
					windowsHide: false,
					shell: false,
					stdio: (FORWARD_CONSOLE && isWin) ? "inherit" : ["inherit", "pipe", "pipe"],
				});
			} catch (err) {
				this._markDown(STATUS.CRASHED, err.message);
				this.pushLog(err.message, LOG.ERROR);
				this._emit();
				if (this._logServer) {
					try { this._logServer.close(); } catch {}
					this._logServer = null;
				}
				return;
			}

			const child = this.proc;
			try { os.setPriority(child.pid, os.constants.priority.PRIORITY_NORMAL); } catch {}

			this._spawning = false;
			this.state.miner.running = true;
			this.state.miner.pid = child.pid;
			this.state.miner.startedAt = Date.now();
			this.state.miner.exitCode = null;
			this.state.miner.signal = null;
			this._setMining({ status: STATUS.STARTING });
			this._emit();

			this._bindStreams(child, FORWARD_CONSOLE && !isWin);
			this._bindLifecycle(child);
		};

		if (FORWARD_CONSOLE && isWin) {
			const pipeName = `\\\\.\\pipe\\srbminer_dashboard_${Date.now()}`;
			for (let i = safeArgs.length - 1; i >= 0; i--) {
				if (safeArgs[i] === "--log-file" || safeArgs[i] === "--log-file-mode") safeArgs.splice(i, 2);
			}
			safeArgs.push("--log-file", pipeName);
			this._logServer = net.createServer((c) => {
				c.setEncoding("utf8");
				c.on("error", () => {});
				c.on("data", createStreamReader(
					(line) => {
						try { parseMinerLine(line, this.state, this._pushLogBound); }
						catch { this.state.dirty = true; }
					},
					() => this._emit(),
					() => true,
					null
				));
			});
			try {
				this._logServer.listen(pipeName, () => doSpawn());
				this._logServer.on("error", () => { if (this._spawning) doSpawn(); });
			} catch {
				doSpawn();
			}
		} else {
			doSpawn();
		}
	}

	_bindStreams(child, forwardConsole) {
		if (!child.stdout || !child.stderr) return;
		const onLine = (line) => {
			try { parseMinerLine(line, this.state, this._pushLogBound); }
			catch { this.state.dirty = true; }
		};
		const onFlush = () => this._emit();
		const alwaysEnabled = () => true;
		const mirror = forwardConsole ? (s) => (c) => { try { s.write(c); } catch {} } : null;
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", createStreamReader(onLine, onFlush, alwaysEnabled, mirror ? mirror(process.stdout) : null));
		child.stderr.on("data", createStreamReader(onLine, onFlush, alwaysEnabled, mirror ? mirror(process.stderr) : null));
		child.stdout.on("error", () => {});
		child.stderr.on("error", () => {});
	}

	_bindLifecycle(child) {
		let settled = false;
		child.on("error", (err) => {
			if (settled) return; settled = true;
			this._markDown(STATUS.CRASHED, err.message);
			this.pushLog(err.message, LOG.ERROR);
			if (this.proc === child) this.proc = null;
			this._emit();
		});
		const onGone = (code, signal) => {
			if (settled) return; settled = true;
			const s = this.state.mining.status;
			const deliberate = s === STATUS.STOPPING || s === STATUS.STOPPED;
			const next = deliberate ? s : code === 0 && !signal ? STATUS.STOPPED : STATUS.CRASHED;
			this._markDown(next);
			this.state.miner.exitCode = code;
			this.state.miner.signal = signal;
			this.state.miner.pid = null;
			this.pushLog(`Exited (code: ${code}${signal ? `, sig: ${signal}` : ""})`, LOG.SYSTEM);
			if (this.proc === child) this.proc = null;
			this._emit();
		};
		child.on("exit", onGone);
		child.on("close", onGone);
	}

	_clearScheduledAction() {
		clearTimeout(this._actionTimer);
		this._actionTimer = null;
		if (this._pendingAction && this._statusRollback && this.proc && this.state.miner.running) {
			this._setMining({ status: this._statusRollback });
			this._emit();
		}
		this._pendingAction = null;
		this._statusRollback = null;
	}

	_markStopped() {
		this.state.miner.running = false;
		this._setMining({ status: STATUS.STOPPED });
		this._emit();
	}

	requestAction(action) {
		if (!Object.prototype.hasOwnProperty.call(ACTIONS, action)) {
			throw new Error(`Unsupported miner action "${action}". Valid actions are: ${Object.keys(ACTIONS).join(", ")}.`);
		}
		if (this._pendingAction === action) return;
		const idle = !this.state.miner.running && !this.proc && this._pendingAction !== "start";
		if (action === "start" && this._alive) return this._clearScheduledAction();
		if (action === "stop" && idle) {
			if (this.state.mining.status !== STATUS.STOPPED) this._markStopped();
			return;
		}
		if (action === "restart" && idle) return this.requestAction("start");
		this._clearScheduledAction();
		this._pendingAction = action;
		this._statusRollback = this.state.mining.status;
		this._setMining({ status: ACTIONS[action] });
		this._emit();
		this._actionTimer = timer(() => {
			const pending = this._pendingAction;
			this._actionTimer = null;
			this._pendingAction = null;
			this._statusRollback = null;
			if (pending && typeof this[pending] === "function") {
				Promise.resolve().then(() => this[pending]()).catch((err) => {
					this.pushLog(`Action "${pending}" failed: ${err && err.message}`, LOG.ERROR);
					this._emit();
				});
			}
		}, LIMITS.ACTION_DELAY_MS);
	}

	stop(options = {}) {
		this._clearScheduledAction();
		this._spawning = false;
		if (!this.proc || !this.state.miner.running) {
			if (this.state.mining.status !== STATUS.STOPPED) this._markStopped();
			return Promise.resolve();
		}
		if (this._stopPromise) return this._stopPromise;
		this._setMining({ status: STATUS.STOPPING });
		this._emit();
		const child = this.proc;
		const pid = child.pid;
		this.isStoppingChild = true;
		this._stopPromise = new Promise((resolve) => {
			let settled = false;
			const finish = () => {
				if (settled) return; settled = true;
				clearTimeout(this._forceKillTimer);
				clearTimeout(watchdog);
				this._forceKillTimer = null;
				if (this.proc === child) this.proc = null;
				this._setMining({ status: STATUS.STOPPED });
				this.state.miner.running = false;
				this._stopPromise = null;
				this.isStoppingChild = false;
				resolve();
			};
			child.once("close", finish);
			child.once("exit", finish);
			const forceKill = () => {
				if (child.exitCode !== null || child.signalCode !== null) return;
				if (process.platform === "win32") {
					execFile("taskkill.exe", ["/pid", String(pid), "/T", "/F"], { shell: false }, () => {});
				} else {
					try { child.kill("SIGKILL"); } catch {}
				}
			};
			if (!options || !options.fromSigint) {
				if (process.platform === "win32") {
					const psCmd = `$m='[DllImport(\"kernel32.dll\")]public static extern bool AttachConsole(uint p);[DllImport(\"kernel32.dll\")]public static extern bool FreeConsole();[DllImport(\"kernel32.dll\")]public static extern bool GenerateConsoleCtrlEvent(uint e,uint p);';Add-Type -MemberDefinition $m -Name K -Namespace W;[W.K]::FreeConsole();[W.K]::AttachConsole(${pid});[W.K]::GenerateConsoleCtrlEvent(0,0);`;
					execFile("powershell", ["-NoProfile", "-NonInteractive", "-Command", psCmd], { windowsHide: true }, () => {});
				} else {
					try { child.kill("SIGINT"); } catch {}
				}
			}
			this._forceKillTimer = timer(forceKill, this.timeouts.forceKill);
			const watchdog = timer(() => {
				if (settled) return;
				this.pushLog("Miner did not exit in time; giving up on a clean stop.", LOG.WARN);
				forceKill();
				finish();
			}, this.timeouts.stop);
		});
		return this._stopPromise;
	}

	async restart() {
		if (this._spawning || this._stopPromise) return;
		await this.stop();
		await new Promise((r) => timer(r, this.timeouts.restartGap));
		await this.start();
	}

	dispose() {
		this._clearScheduledAction();
		clearTimeout(this._forceKillTimer);
		this._forceKillTimer = null;
		if (this._probe) {
			try { this._probe.kill("SIGKILL"); } catch {}
			this._probe = null;
		}
		if (this._logServer) {
			try { this._logServer.close(); } catch {}
			this._logServer = null;
		}
	}
}

module.exports = { MinerManager };
