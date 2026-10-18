const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawn, execFile } = require("node:child_process");
const { parseMinerLine } = require("./parser");
const { STATUS, LOG, LIMITS } = require("../utils/constants");
const { parseCudaDeviceList, createStreamReader } = require("./devices");
const { unrefTimer: timer } = require("../utils/timers");

const SHELL_METACHAR_RE = /[&|`$()\n\r<>]/;
const containsShellMetachars = (str) => SHELL_METACHAR_RE.test(str);

const ACTIONS = Object.freeze({
	start: STATUS.STARTING,
	stop: STATUS.STOPPING,
	restart: STATUS.RESTARTING,
});

const CLEAN_STATS = Object.freeze({
	hashrateKHs: null,
	hashrateTotal: 0,
	hashrateCpu: 0,
	hashrateGpu: 0,
	accepted: 0,
	submitted: 0,
	rejected: 0,
	difficulty: null,
	poolLatency: null,
	poolLatencies: [],
	algorithms: [],
	idleSince: null,
	restartAt: null,
	recovering: false,
	positivePings: 0,
	zeroPings: 0,
	idleZeroSeen: false,
	dagBuilding: false,
	dagStartedAt: 0,
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
			idle: timeouts.idle ?? LIMITS.IDLE_TIMEOUT_MS,
			settle: timeouts.settle ?? LIMITS.IDLE_SETTLE_MS,
		};
		this.proc = null;
		this.isStoppingChild = false;
		this._restarting = false;
		this._stopPromise = null;
		this._forceKillTimer = null;
		this._actionTimer = null;
		this._idleTimer = null;
		this._pendingRestartType = null;
		this._adoptedPid = null;
		this._activePipe = null;
		this._pendingAction = null;
		this._statusRollback = null;
		this._spawning = false;
		this._probe = null;
		this._logServer = null;
		this._pushLogBound = (text, type) => this.pushLog(text, type);
		this._onLine = (line) => {
			try {
				if (!this.state.miner.running && this.state.mining.recovering && /miner\s+version:/i.test(line)) {
					this.onSelfRestartDetected();
				}
				const prev = this.state.mining.status;
				parseMinerLine(line, this.state, this._pushLogBound);
				if (this.state.mining.status === STATUS.IDLE && (prev !== STATUS.IDLE || !this._idleTimer)) {
					this.enterIdle(this.state.miner.lastError);
				}
			} catch {
				this.state.dirty = true;
			}
		};
	}

	get isBusy() {
		const s = this.state.mining.status;
		return Boolean(
			(!this.state.miner.running && !this.state.mining.recovering) ||
			this._spawning ||
			this.isStoppingChild ||
			this._stopPromise ||
			this._restarting ||
			this._pendingAction === "stop" ||
			this._pendingAction === "restart" ||
			s === STATUS.STOPPING ||
			s === STATUS.STOPPED ||
			s === STATUS.RESTARTING
		);
	}

	_findMinerPid() {
		return new Promise((resolve) => {
			if (process.platform !== "win32") return resolve(null);
			const exeName = path.basename(this.config.MINER_EXE || "SRBMiner-MULTI.exe");
			execFile("tasklist.exe", ["/FI", `IMAGENAME eq ${exeName}`, "/FO", "CSV", "/NH"], { shell: false, windowsHide: true }, (err, stdout) => {
				if (err || !stdout) return resolve(null);
				const lines = stdout.trim().split(/\r?\n/);
				const pids = [];
				for (const line of lines) {
					const parts = line.split('","');
					if (parts.length >= 2) {
						const p = parseInt(parts[1].replace(/"/g, ""), 10);
						if (Number.isFinite(p) && p > 0 && p !== process.pid) pids.push(p);
					}
				}
				if (!pids.length) return resolve(null);
				const currentPid = this.state.miner.pid;
				const cand = pids.find((p) => p !== currentPid) || pids[pids.length - 1];
				resolve(cand);
			});
		});
	}

	onSelfRestartDetected() {
		if (this.isBusy) return;
		if (!this._pendingRestartType) this._pendingRestartType = "normal";
		this.state.miner.running = true;
		this.state.miner.startedAt = Date.now();
		this.state.mining.recovering = true;
		this.state.mining.idleZeroSeen = true;
		this.state.mining.positivePings = 0;
		if (this.state.mining.status !== STATUS.IDLE || !this._idleTimer) {
			this.enterIdle(this.state.miner.lastError);
		}
		this.pushLog("Miner self-restart detected; waiting for mining to resume...", LOG.SYSTEM);
		this._findMinerPid().then((newPid) => {
			if (newPid) {
				this.state.miner.pid = newPid;
				this._adoptedPid = newPid;
			}
			this._emit();
		});
		this._emit();
	}

	triggerHardRestart(reason, isError = false) {
		if (this.isBusy) return;
		this.clearIdle(false);
		this._pendingRestartType = "hard";
		if (reason) {
			if (isError) this.state.miner.lastError = reason;
			this.pushLog(reason, isError ? LOG.ERROR : LOG.WARN);
		}
		this.autoRestart();
	}

	enterIdle(reason) {
		if (this.isBusy) return;
		if (reason) this.state.miner.lastError = reason;
		const m = this.state.mining;
		m.dagBuilding = false;
		if (!this._pendingRestartType) this._pendingRestartType = "normal";
		if (m.status === STATUS.IDLE && m.restartAt && this._idleTimer) {
			this.state.dirty = true;
			this._emit();
			return;
		}
		const now = Date.now();
		this._setMining({
			status: STATUS.IDLE,
			idleSince: now,
			restartAt: now + this.timeouts.idle,
			positivePings: 0,
			idleZeroSeen: m.zeroPings >= LIMITS.IDLE_ZERO_PINGS || Boolean(m.recovering),
		});
		clearTimeout(this._idleTimer);
		this._idleTimer = timer(() => {
			this._idleTimer = null;
			if (this.isBusy || (this.state.mining.status !== STATUS.IDLE && !this.state.mining.recovering)) return;
			this.triggerHardRestart("Watchdog: Miner did not recover within 60s grace period; initiating hard restart.");
		}, this.timeouts.idle);
		this._emit();
	}

	clearIdle(recoverToMining = false) {
		clearTimeout(this._idleTimer);
		this._idleTimer = null;
		const patch = {
			idleSince: null,
			restartAt: null,
			recovering: false,
			positivePings: 0,
			zeroPings: 0,
			idleZeroSeen: false,
		};
		if (recoverToMining && !this.isBusy) {
			this.state.miner.lastError = "";
			patch.status = STATUS.MINING;
			const rType = this._pendingRestartType;
			this._pendingRestartType = null;
			if (rType === "hard") {
				patch.hardRestarts = (this.state.mining.hardRestarts || 0) + 1;
				patch.autoRestarts = (this.state.mining.normalRestarts || 0) + patch.hardRestarts;
				this._setMining(patch);
				this.pushLog("Hard restart completed; miner is hashing again.", LOG.SUCCESS);
			} else if (rType === "normal") {
				patch.normalRestarts = (this.state.mining.normalRestarts || 0) + 1;
				patch.autoRestarts = patch.normalRestarts + (this.state.mining.hardRestarts || 0);
				this._setMining(patch);
				this.pushLog("Miner self-restarted and resumed mining (normal restart).", LOG.SUCCESS);
			} else {
				this._setMining(patch);
			}
			this._emit();
		} else {
			this._setMining(patch);
		}
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
		clearTimeout(this._idleTimer);
		this._idleTimer = null;
		this._setMining({ ...CLEAN_STATS });
		this.state.mining.gpuHashrates = Object.create(null);
		this.state.mining.gpuAlgos = Object.create(null);
		this.state.mining.apiLatencies = Object.create(null);
		this.state.mining.consoleLatencies = Object.create(null);
		this.state.mining.poolStates = Object.create(null);
		this.state.gpu = [];
		this.state.cpu = [];
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

		if (!this.state.miner.sessionStartedAt) {
			this.state.miner.sessionStartedAt = Date.now();
		}
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
		["--extended-log", "--enable-restart-on-rejected"].forEach(a => { if (!safeArgs.includes(a)) safeArgs.push(a); });
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
			this._adoptedPid = null;
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
				const isAdopted = !this._spawning && (this.state.mining.recovering || !this.proc);
				this._activePipe = c;
				if (isAdopted) {
					this.onSelfRestartDetected();
				}
				c.setEncoding("utf8");
				c.on("error", () => {});
				c.on("close", () => {
					if (isAdopted && this._activePipe === c && this.state.miner.running && !this.isStoppingChild && !this._restarting) {
						this._onUnexpectedExit();
					}
				});
				c.on("data", createStreamReader(
					this._onLine,
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
		const onFlush = () => this._emit();
		const alwaysEnabled = () => true;
		const mirror = forwardConsole ? (s) => (c) => { try { s.write(c); } catch {} } : null;
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", createStreamReader(this._onLine, onFlush, alwaysEnabled, mirror ? mirror(process.stdout) : null));
		child.stderr.on("data", createStreamReader(this._onLine, onFlush, alwaysEnabled, mirror ? mirror(process.stderr) : null));
		child.stdout.on("error", () => {});
		child.stderr.on("error", () => {});
	}

	_onUnexpectedExit() {
		this.state.miner.pid = null;
		this.state.miner.running = false;
		this.state.mining.recovering = true;
		this.pushLog("Miner exited unexpectedly; waiting 60s for self-restart.", LOG.WARN);
		this.enterIdle(this.state.miner.lastError || "Miner exited unexpectedly");
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
			const isRestart = this._restarting || this._pendingAction === "restart" || s === STATUS.RESTARTING;
			const deliberate = isRestart || this.isStoppingChild || this._pendingAction === "stop" || s === STATUS.STOPPING || s === STATUS.STOPPED;
			this.state.miner.exitCode = code;
			this.state.miner.signal = signal;
			this.pushLog(`Exited (code: ${code}${signal ? `, sig: ${signal}` : ""})`, LOG.SYSTEM);
			if (this.proc === child) this.proc = null;

			if (deliberate) {
				const next = isRestart ? STATUS.RESTARTING : STATUS.STOPPED;
				this._markDown(next);
				this.state.miner.pid = null;
				this._emit();
				return;
			}

			this._onUnexpectedExit();
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
		this.clearIdle(false);
		this.state.miner.running = false;
		this._setMining({ status: STATUS.STOPPED });
		this._emit();
	}

	_scheduleAction(action) {
		this.clearIdle(false);
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

	requestAction(action) {
		if (!Object.prototype.hasOwnProperty.call(ACTIONS, action)) {
			throw new Error(`Unsupported miner action "${action}". Valid actions are: ${Object.keys(ACTIONS).join(", ")}.`);
		}
		if (this._pendingAction === action) return;
		this._pendingRestartType = null;
		const idle = !this.state.miner.running && !this.proc && !this.state.mining.recovering && this._pendingAction !== "start";
		this.state.mining.autoRestarts = 0;
		this.state.mining.normalRestarts = 0;
		this.state.mining.hardRestarts = 0;
		if (action === "start") {
			this.state.miner.sessionStartedAt = Date.now();
			if (this._alive) return this._clearScheduledAction();
		}
		if (action === "restart") {
			this.state.miner.sessionStartedAt = Date.now();
			if (idle) return this.requestAction("start");
		}
		if (action === "stop") {
			this.state.miner.sessionStartedAt = null;
			if (idle) {
				if (this.state.mining.status !== STATUS.STOPPED) this._markStopped();
				return;
			}
		}
		this._scheduleAction(action);
	}

	autoRestart() {
		if (this._pendingAction === "restart" || this._restarting || this.isStoppingChild) return;
		this._scheduleAction("restart");
	}

	stop(options = {}) {
		this.clearIdle(false);
		this._clearScheduledAction();
		this._spawning = false;
		const targetPid = (this.proc && this.proc.pid) || this.state.miner.pid || this._adoptedPid;
		if (!targetPid && !this.proc && !this.state.miner.running) {
			if (!this._restarting && this.state.mining.status !== STATUS.STOPPED) this._markStopped();
			return Promise.resolve();
		}
		if (this._stopPromise) return this._stopPromise;
		this._setMining({ status: this._restarting ? STATUS.RESTARTING : STATUS.STOPPING });
		this._emit();
		const child = this.proc;
		const pid = targetPid;
		const exeName = path.basename(this.config.MINER_EXE || "SRBMiner-MULTI.exe");
		this.isStoppingChild = true;
		this._stopPromise = new Promise((resolve) => {
			let settled = false;
			let watchdog = null;
			const finish = () => {
				if (settled) return; settled = true;
				clearTimeout(this._forceKillTimer);
				clearTimeout(watchdog);
				this._forceKillTimer = null;
				if (this.proc === child) this.proc = null;
				this._adoptedPid = null;
				this.state.miner.pid = null;
				this._setMining({ status: this._restarting ? STATUS.RESTARTING : STATUS.STOPPED });
				this.state.miner.running = false;
				this._stopPromise = null;
				this.isStoppingChild = false;
				resolve();
			};
			if (child) {
				child.once("close", finish);
				child.once("exit", finish);
			}
			const forceKill = (done) => {
				const cb = typeof done === "function" ? done : () => {};
				if (child && (child.exitCode !== null || child.signalCode !== null)) return cb();
				if (process.platform === "win32") {
					const args = pid ? ["/pid", String(pid), "/T", "/F"] : ["/IM", exeName, "/T", "/F"];
					execFile("taskkill.exe", args, { shell: false }, cb);
				} else {
					try { if (pid) process.kill(pid, "SIGKILL"); } catch {}
					cb();
				}
			};
			const sendCtrlC = (cb) => {
				const done = typeof cb === "function" ? cb : () => {};
				if (options && options.fromSigint) return done();
				if (process.platform === "win32" && pid) {
					const psCmd = `$m='[DllImport(\"kernel32.dll\")]public static extern bool AttachConsole(uint p);[DllImport(\"kernel32.dll\")]public static extern bool FreeConsole();[DllImport(\"kernel32.dll\")]public static extern bool GenerateConsoleCtrlEvent(uint e,uint p);';Add-Type -MemberDefinition $m -Name K -Namespace W;[W.K]::FreeConsole();[W.K]::AttachConsole(${pid});[W.K]::GenerateConsoleCtrlEvent(0,0);`;
					execFile("powershell", ["-NoProfile", "-NonInteractive", "-Command", psCmd], { windowsHide: true }, () => done());
				} else {
					try { if (child) child.kill("SIGINT"); else if (pid) process.kill(pid, "SIGINT"); } catch {}
					done();
				}
			};
			if (!child) {
				if (!options || !options.fromSigint) {
					sendCtrlC(() => {
						this._forceKillTimer = setTimeout(() => forceKill(finish), 800);
					});
				} else {
					forceKill(finish);
				}
				return;
			}
			sendCtrlC();
			this._forceKillTimer = timer(forceKill, this.timeouts.forceKill);
			watchdog = timer(() => {
				if (settled) return;
				this.pushLog("Miner did not exit in time; giving up on a clean stop.", LOG.WARN);
				forceKill(finish);
			}, this.timeouts.stop);
		});
		return this._stopPromise;
	}

	async restart() {
		if (this._spawning || this._stopPromise) return;
		this._restarting = true;
		try {
			await this.stop();
			await new Promise((r) => timer(r, this.timeouts.restartGap));
			await this.start();
		} finally {
			this._restarting = false;
		}
	}

	dispose() {
		this.clearIdle(false);
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
