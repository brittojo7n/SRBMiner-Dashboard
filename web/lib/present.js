import { cleanPoolAddress, parsePoolList, parseMinerWallet } from "./user.js";

export const DASH = "\u2014";
const pad = (n) => String(n).padStart(2, "0");
export const num = (v, d = 1) => v == null || !Number.isFinite(v) ? DASH : Number(v).toFixed(d);
export function uptime(totalSeconds) {
	let s = Math.max(0, Math.floor(totalSeconds || 0));
	const d = Math.floor(s / 86400); s %= 86400;
	const h = Math.floor(s / 3600); s %= 3600;
	const m = Math.floor(s / 60); const sec = s % 60;
	return d > 0 ? `${d}d ${h}h ${m}m` : `${pad(h)}:${pad(m)}:${pad(sec)}`;
}
export function timestamp(ms, tz) {
	const d = new Date(ms);
	const base = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
	return tz ? `${base} (${tz})` : base;
}
export const stripLogPrefix = (text) => String(text).replace(/^\[[^\]]+\]\s*\w+\s*/, "");
const tempStatus = (t, levels) => t == null ? null : t >= levels.hot ? "danger" : t >= levels.warn ? "warn" : "ok";
export const IDLE_STATUS = new Set(["STOPPED", "CRASHED", "ERROR"]);
export const LIVE_STATUS = new Set(["MINING", "CONNECTED", "WAITING", "DISCONNECTED"]);
function effectiveStatus(snapshot, pending) {
	if (pending) return pending;
	const s = snapshot.mining.status;
	return !snapshot.miner.running && LIVE_STATUS.has(s) ? "STOPPED" : s;
}
export function dotClass(status) {
	if (IDLE_STATUS.has(status)) return "dot err";
	return status === "MINING" || status === "CONNECTED" ? "dot ok" : "dot warn";
}
export function sharesPerMinute(accepted, elapsedMs) {
	const spm = elapsedMs > 0 ? accepted / (elapsedMs / 60000) : accepted;
	return spm > 0 ? num(spm, 3) : DASH;
}
export function formatHashrate(h) {
	if (h == null || !Number.isFinite(h) || h === 0) return DASH;
	if (h >= 1e9) return `${num(h / 1e9, 2)} GH/s`;
	if (h >= 1e6) return `${num(h / 1e6, 2)} MH/s`;
	if (h >= 1e3) return `${num(h / 1e3, 2)} kH/s`;
	return `${num(h, 2)} H/s`;
}
export function formatEfficiency(eff) {
	if (eff == null || !Number.isFinite(eff) || eff <= 0) return { value: DASH, unit: "H/s/W", text: DASH };
	const u = eff >= 1e9 ? "GH/s/W" : eff >= 1e6 ? "MH/s/W" : eff >= 1e3 ? "kH/s/W" : "H/s/W";
	const div = eff >= 1e9 ? 1e9 : eff >= 1e6 ? 1e6 : eff >= 1e3 ? 1e3 : 1;
	const val = num(eff / div, 2);
	return { value: val, unit: u, text: `${val} ${u}` };
}
export function formatLatencyItem(entry, globalStatus) {
	const status = entry?.status || (globalStatus === "STOPPED" ? "stopped" : "connecting");
	const lat = entry?.latency;
	if (status === "disconnected") {
		return { text: "Disconnected", status: "danger", num: "Disconnected", unit: "" };
	}
	if (status === "reconnecting") {
		return { text: "Reconnecting...", status: "warn", num: "Reconnecting...", unit: "" };
	}
	if (lat != null && Number.isFinite(lat) && lat >= 0) {
		return { text: `${num(lat, 0)} ms`, status: null, num: num(lat, 0), unit: "ms" };
	}
	if (status === "connected") {
		return { text: "Connected", status: null, num: "Connected", unit: "" };
	}
	if (status === "connecting" || globalStatus === "STARTING" || globalStatus === "WAITING" || globalStatus === "CONNECTED" || globalStatus === "MINING") {
		return { text: "Connecting...", status: "warn", num: "Connecting...", unit: "" };
	}
	return { text: DASH, status: null, num: DASH, unit: "" };
}

export function presentSnapshot(snapshot, options = {}) {
	const m = snapshot.mining;
	const currentStatus = effectiveStatus(snapshot, options.pendingStatus || null);
	const hasCpu = Number.isFinite(m.hashrateCpu) && m.hashrateCpu > 0;
	const hasGpu = Number.isFinite(m.hashrateGpu) && m.hashrateGpu > 0;
	const totalHz = (hasCpu || hasGpu)
		? ((m.hashrateCpu || 0) + (m.hashrateGpu || 0))
		: (m.hashrateTotal || (m.hashrateKHs ? m.hashrateKHs * 1000 : 0));
	const poolsFromAlgos = (m.algorithms || [])
		.map((a) => cleanPoolAddress(a.pool && a.pool.address))
		.filter(Boolean);
	const poolsFromMiner = parsePoolList(snapshot.miner.pool || "");
	const allPools = poolsFromAlgos.length > 0 ? poolsFromAlgos : poolsFromMiner;

	const poolLatencies = Array.isArray(m.poolLatencies) && m.poolLatencies.length > 0
		? m.poolLatencies.map((entry, idx) => {
			const formatted = formatLatencyItem(entry, currentStatus);
			return {
				id: entry.id ?? idx,
				tag: `POOL ${idx + 1}`,
				text: formatted.text,
				num: formatted.num,
				unit: formatted.unit,
				status: formatted.status,
			};
		})
		: [(() => {
			const f = formatLatencyItem({ latency: m.poolLatency, status: currentStatus === "MINING" ? "connected" : currentStatus }, currentStatus);
			return { id: 0, tag: "POOL 1", text: f.text, num: f.num, unit: f.unit, status: f.status };
		})()];

	const primaryLatency = poolLatencies[0] || { text: DASH, status: null };

	return {
		status: currentStatus,
		hashrate: formatHashrate(totalHz),
		hashrateCpu: formatHashrate(m.hashrateCpu || 0),
		hashrateGpu: formatHashrate(m.hashrateGpu || 0),
		hasCpuMining: hasCpu,
		hasGpuMining: hasGpu,
		accepted: m.submitted === 0 ? DASH : `${m.accepted} / ${m.submitted}`,
		acceptedCount: String(m.accepted ?? 0),
		ratio: snapshot.acceptedRatio == null ? DASH : `${num(snapshot.acceptedRatio, 2)}%`,
		rejected: String(m.rejected ?? 0),
		difficulty: m.difficulty == null ? DASH : String(m.difficulty),
		poolLatency: primaryLatency.text,
		poolLatencyStatus: primaryLatency.status,
		poolLatencies,
		lastAccepted: m.lastAcceptedAt ? timestamp(m.lastAcceptedAt) : DASH,
		wallet: parseMinerWallet(snapshot.miner.wallet || ""),
		algo: (m.algorithms && m.algorithms.length > 0)
			? m.algorithms.map((a) => a.name).join(", ")
			: (snapshot.miner.algo || ""),
		pool: allPools[0] || "",
		pools: allPools,
		host: snapshot.host.hostname || "",
	};
}
export function presentGpu(gpu, opts = {}) {
	const levels = opts.tempLevels || { warn: 72, hot: 80 };
	const eff = gpu.hashrate > 0 && gpu.powerW > 0 ? gpu.hashrate / gpu.powerW : null;
	const effParsed = formatEfficiency(eff);
	const hasUtil = gpu.utilizationPct != null;
	const util = hasUtil ? Math.max(0, Math.min(100, gpu.utilizationPct)) : 0;
	return {
		name: `GPU ${gpu.index} \u2022 ${gpu.name || "Unknown"}`,
		pstate: gpu.pstate || null,
		hasPstate: gpu.pstate != null && gpu.pstate !== "",
		temp: gpu.temperatureC != null ? `${num(gpu.temperatureC, 0)}\u00b0C` : DASH,
		tempStatus: tempStatus(gpu.temperatureC, levels),
		power: num(gpu.powerW, 1),
		core: num(gpu.coreMHz, 0),
		mem: num(gpu.memoryMHz, 0),
		hasVram: gpu.memoryTotalMB != null && gpu.memoryTotalMB > 0,
		vramUsed: num(gpu.memoryUsedMB, 0),
		vramTotal: num(gpu.memoryTotalMB, 0),
		hashrate: formatHashrate(gpu.hashrate),
		eff: effParsed.value,
		effUnit: effParsed.unit,
		hasUtil,
		util: hasUtil ? num(gpu.utilizationPct, 0) : DASH,
		barScale: util / 100,
	};
}
