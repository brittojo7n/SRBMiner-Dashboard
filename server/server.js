const os = require("node:os");
const config = require("./utils/config");
const { createState } = require("./utils/state");
const { GpuManager } = require("./miner/gpu");
const { SseHub } = require("./http/sse");
const { MinerManager } = require("./miner/miner");
const { ApiManager } = require("./miner/api");
const { createHttpServer, getLanIp } = require("./http/http");
const { LIMITS, LOG } = require("./utils/constants");
const { unrefTimer } = require("./utils/timers");

function yieldCpuToMiner() {
	if (process.platform !== "win32") return false;
	try {
		os.setPriority(process.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
		return true;
	} catch {
		return false;
	}
}

class Server {
	constructor(options = {}) {
		this.config = options.config || config;
		this.state = createState(
			this.config.WALLET,
			LIMITS.MAX_LOGS,
			this.config.ALGO,
			this.config.POOL
		);
		this._exiting = false;
		this._shutdownWatchdog = null;
		let idleTimeout = null;

		this.sseHub = new SseHub({
			state: this.state,
			onSubscriberChange: (count) => {
				if (count > 0) {
					if (idleTimeout) {
						clearTimeout(idleTimeout);
						idleTimeout = null;
					}
					this.gpuManager.start();
					this.apiManager.start();
				} else if (!idleTimeout) {
					idleTimeout = unrefTimer(() => {
						this.gpuManager.stop();
						this.apiManager.stop();
						idleTimeout = null;
					}, 20000);
				}
			},
		});

		this.gpuManager = new GpuManager({ state: this.state, pollMs: this.config.GPU_POLL_MS, onUpdate: () => this.sseHub.broadcast() });
		this.apiManager = new ApiManager({ state: this.state, port: this.config.API_PORT, pollMs: this.config.API_POLL_MS, onUpdate: () => this.sseHub.broadcast() });
		this.minerManager = new MinerManager({ config: this.config, state: this.state, onUpdate: () => this.sseHub.broadcast() });
		this.httpServer = createHttpServer({
			config: this.config,
			state: this.state,
			sseHub: this.sseHub,
			minerManager: this.minerManager,
			gpuManager: this.gpuManager,
			apiManager: this.apiManager,
			webDir: options.webDir,
		});

		this.boundExit = (fromSigint = false) => this.stop(0, fromSigint);
		this.handleSigint = () => {
			if (this.minerManager && this.minerManager.isStoppingChild) return;
			this.boundExit(true);
		};
		this.handleFault = (scope, err) => this._onFault(scope, err);
	}

	_onFault(scope, err) {
		const msg = (err && err.message) || String(err);
		console.error(`[dashboard] critical error (${scope}):`, msg);
		try {
			this.minerManager.pushLog(`Dashboard internal error (${scope}): ${msg}`, LOG.ERROR);
			this.sseHub.broadcast();
		} catch (e) {
			console.error(`[dashboard] failed broadcasting fault (${scope}):`, e.message);
		}
	}

	start() {
		this._attachSignalHandlers();
		yieldCpuToMiner();
		this._listening = false;
		this.httpServer.on("error", (err) => {
			if (!this._listening) process.exit(1);
			this._onFault("http", err);
		});
		this.httpServer.listen(this.config.PORT, this.config.HOST, () => {
			this._listening = true;
			const port = this.httpServer.address().port;
			console.log(`http://${this.config.HOST}:${port}\nLAN: http://${getLanIp()}:${port}`);
		});
		this.minerManager.start();
		return this;
	}

	stop(exitCode = 0, fromSigint = false) {
		if (this._exiting) return this._stopPromise || Promise.resolve();
		this._exiting = true;
		this.gpuManager.stop();
		this.apiManager.stop();
		this.state.mining.consoleLatencies = Object.create(null);
		this.state.mining.apiLatencies = Object.create(null);
		this.state.mining.poolStates = Object.create(null);
		this.state.mining.poolLatency = null;
		this.state.mining.poolLatencies = [];
		this.sseHub.closeAll();
		this._shutdownWatchdog = unrefTimer(() => process.exit(exitCode), LIMITS.SHUTDOWN_TIMEOUT_MS);
		const closeHttpServer = () =>
			new Promise((resolve) => {
				if (!this.httpServer.listening) return resolve();
				if (typeof this.httpServer.closeAllConnections === "function") this.httpServer.closeAllConnections();
				this.httpServer.close(() => resolve());
			});
		this._stopPromise = Promise.resolve()
			.then(() => this.minerManager.stop({ fromSigint }))
			.catch((err) => this._onFault("miner-stop", err))
			.then(() => {
				this.minerManager.dispose();
				return closeHttpServer();
			})
			.catch((err) => this._onFault("http-close", err))
			.then(() => {
				clearTimeout(this._shutdownWatchdog);
				this._detachSignalHandlers();
				process.exit(exitCode);
			});
		return this._stopPromise;
	}

	_attachSignalHandlers() {
		this._onUncaught = (err) => this.handleFault("uncaughtException", err);
		this._onRejection = (err) => this.handleFault("unhandledRejection", err);
		process.on("SIGINT", this.handleSigint);
		process.on("SIGTERM", this.boundExit);
		process.on("uncaughtException", this._onUncaught);
		process.on("unhandledRejection", this._onRejection);
	}

	_detachSignalHandlers() {
		process.removeListener("SIGINT", this.handleSigint);
		process.removeListener("SIGTERM", this.boundExit);
		if (this._onUncaught) process.removeListener("uncaughtException", this._onUncaught);
		if (this._onRejection) process.removeListener("unhandledRejection", this._onRejection);
	}
}

module.exports = { Server, yieldCpuToMiner };
