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

function createState(wallet = "", maxLogs = 50, algo = "", pool = "") {
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
			wallet,
			algo: algo || "",
			pool: pool || "",
		},
		mining: {
			hashrateKHs: null,
			hashrateTotal: 0,
			hashrateCpu: 0,
			hashrateGpu: 0,
			poolLatency: null,
			poolLatencies: [],
			consoleLatencies: Object.create(null),
			apiLatencies: Object.create(null),
			poolStates: Object.create(null),
			accepted: 0,
			submitted: 0,
			rejected: 0,
			difficulty: null,
			status: STATUS.STOPPED,
			lastAcceptedAt: null,
			gpuHashrates: Object.create(null),
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
	const devIndex = gpu.minerId != null ? gpu.minerId : (mapped !== undefined ? mapped : gpu.index);
	const rates = state.mining.gpuHashrates;
	const direct = rates[`gpu${devIndex}`] ?? rates[`cu_${devIndex}`] ?? rates[`cl_${devIndex}`] ?? rates[devIndex];
	if (direct !== undefined) return direct;
	if (state.gpu.length === 1 && state.mining.hashrateGpu > 0) return state.mining.hashrateGpu;
	return null;
}

function getPoolLatencies(state) {
	const mining = state.mining;
	const algos = mining.algorithms || [];
	const isStopped = mining.status === STATUS.STOPPED;
	const list = [];
	if (algos.length > 0) {
		for (let i = 0; i < algos.length; i++) {
			const a = algos[i];
			const cLat = mining.consoleLatencies ? mining.consoleLatencies[i] : null;
			const aLat = mining.apiLatencies ? mining.apiLatencies[i] : (a.pool ? a.pool.latency : null);
			const lat = cLat != null ? cLat : (aLat != null ? aLat : null);
			const st = isStopped ? "stopped" : ((mining.poolStates && mining.poolStates[i]) || "connecting");
			list.push({
				id: i,
				name: a.name || `Algo ${i + 1}`,
				pool: (a.pool && a.pool.address) || "",
				latency: lat,
				status: st,
			});
		}
	} else {
		const cLat = mining.consoleLatencies ? mining.consoleLatencies[0] : null;
		const aLat = mining.apiLatencies ? mining.apiLatencies[0] : null;
		const lat = cLat != null ? cLat : (aLat != null ? aLat : mining.poolLatency);
		const st = isStopped ? "stopped" : ((mining.poolStates && mining.poolStates[0]) || "connecting");
		list.push({
			id: 0,
			name: "Pool 1",
			pool: state.miner.pool || "",
			latency: lat,
			status: st,
		});
	}
	return list;
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
			lastError: miner.lastError, wallet: miner.wallet, logs: entries,
			algo: miner.algo || "", pool: miner.pool || "",
		},
		logsFrom, logSeq: logs.seq, logCount: logs.length, logCapacity: logs.capacity,
		mining: {
			hashrateKHs: mining.hashrateKHs,
			hashrateTotal: mining.hashrateTotal,
			hashrateCpu: mining.hashrateCpu,
			hashrateGpu: mining.hashrateGpu,
			poolLatency: mining.poolLatency,
			poolLatencies: getPoolLatencies(state),
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
