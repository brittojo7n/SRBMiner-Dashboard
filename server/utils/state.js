const os = require("node:os");
const { STATUS } = require("./constants");

class CircularLogBuffer {
	constructor(capacity = 50) {
		this.capacity = Math.max(1, capacity | 0);
		this.buf = new Array(this.capacity);
		this.head = 0;
		this.count = 0;
		this.seq = 0;
	}

	push(text, type = "info") {
		this.buf[this.head] = { id: ++this.seq, text, type };
		this.head = (this.head + 1) % this.capacity;
		if (this.count < this.capacity) this.count++;
		return this.seq;
	}

	get length() {
		return this.count;
	}

	toJSON() {
		if (this.count < this.capacity) return this.buf.slice(0, this.count);
		return this.buf.slice(this.head).concat(this.buf.slice(0, this.head));
	}

	since(sinceId) {
		if (!Number.isFinite(sinceId) || sinceId <= 0) return this.toJSON();
		if (sinceId >= this.seq) return [];
		const missing = this.seq - sinceId;
		if (missing >= this.count) return this.toJSON();
		const out = new Array(missing);
		for (let i = 0; i < missing; i++) {
			const idx = (this.head - missing + i + this.capacity) % this.capacity;
			out[i] = this.buf[idx];
		}
		return out;
	}
}

function getServerTz() {
	const off = -new Date().getTimezoneOffset();
	const sign = off >= 0 ? "+" : "-";
	const abs = Math.abs(off);
	return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

const SERVER_TZ = getServerTz();
const HOSTNAME = os.hostname();

function createState(wallet = "", maxLogs = 50, worker = null, user = "", algo = "", pool = "") {
	return {
		dirty: true,
		startedAt: Date.now(),
		gpuError: "",
		miner: {
			running: false,
			pid: null,
			startedAt: null,
			exitCode: null,
			signal: null,
			lastLine: "",
			lastError: "",
			logs: new CircularLogBuffer(maxLogs),
			user: user || "",
			wallet,
			worker: worker || null,
			algo: algo || "",
			pool: pool || "",
		},
		mining: {
			hashrateKHs: null,
			hashrateTotal: 0,
			hashrateCpu: 0,
			hashrateGpu: 0,
			poolLatency: null,
			accepted: 0,
			submitted: 0,
			rejected: 0,
			difficulty: null,
			status: STATUS.STOPPED,
			lastAcceptedAt: null,
			gpuHashrates: Object.create(null),
			seenDevices: [],
			pciMap: Object.create(null),
			algorithms: [],
			rigName: "",
			minerVersion: "",
		},
		gpu: [],
		cpu: [],
		apiGpuDevices: [],
		host: { hostname: HOSTNAME, tz: SERVER_TZ },
	};
}

function hashrateForGpu(state, gpu) {
	const mapped = state.mining.pciMap[gpu.pciBusId];
	const devIndex = mapped !== undefined ? mapped : gpu.index;
	const rates = state.mining.gpuHashrates;
	const direct = rates[`gpu${devIndex}`] ?? rates[`cu_${devIndex}`] ?? rates[`cl_${devIndex}`] ?? rates[devIndex];
	if (direct !== undefined) return direct;
	if (state.gpu.length === 1 && state.mining.hashrateGpu > 0) return state.mining.hashrateGpu;
	return null;
}

function formatStatsSnapshot(state, options) {
	const now = Date.now();
	const { miner, mining } = state;
	const minerStart = miner.startedAt || state.startedAt;
	const logs = miner.logs;
	const sinceId = options && Number.isFinite(options.logsSince) ? options.logsSince : 0;
	const entries = sinceId > 0 ? logs.since(sinceId) : logs.toJSON();
	const logsFrom = entries.length ? entries[0].id : logs.seq + 1;
	const gpus = state.gpu;
	for (let i = 0; i < gpus.length; i++) gpus[i].hashrate = hashrateForGpu(state, gpus[i]);
	return {
		now,
		uptimeSeconds: miner.running && minerStart ? Math.max(0, Math.floor((now - minerStart) / 1000)) : 0,
		acceptedRatio: mining.submitted > 0 ? (mining.accepted / mining.submitted) * 100 : null,
		startedAt: minerStart,
		miner: {
			running: miner.running, pid: miner.pid, startedAt: miner.startedAt,
			exitCode: miner.exitCode, signal: miner.signal, lastLine: miner.lastLine,
			lastError: miner.lastError, user: miner.user || "", wallet: miner.wallet,
			worker: miner.worker || null, logs: entries,
			algo: miner.algo || "", pool: miner.pool || "",
		},
		logsFrom, logSeq: logs.seq, logCount: logs.length, logCapacity: logs.capacity,
		mining: {
			hashrateKHs: mining.hashrateKHs,
			hashrateTotal: mining.hashrateTotal,
			hashrateCpu: mining.hashrateCpu,
			hashrateGpu: mining.hashrateGpu,
			poolLatency: mining.poolLatency,
			accepted: mining.accepted, submitted: mining.submitted,
			rejected: mining.rejected, difficulty: mining.difficulty, status: mining.status,
			lastAcceptedAt: mining.lastAcceptedAt,
			algorithms: mining.algorithms || [],
			rigName: mining.rigName || "",
			minerVersion: mining.minerVersion || "",
		},
		gpuError: state.gpuError || "",
		gpu: gpus,
		cpu: state.cpu,
		host: state.host,
	};
}

module.exports = { createState, formatStatsSnapshot };
