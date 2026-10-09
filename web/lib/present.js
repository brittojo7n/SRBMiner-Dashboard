import { cleanPoolAddress } from "./user.js";

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
export function presentSnapshot(snapshot, options = {}) {
	const m = snapshot.mining;
	return {
		status: effectiveStatus(snapshot, options.pendingStatus || null),
		hashrate: formatHashrate(m.hashrateTotal || (m.hashrateKHs ? m.hashrateKHs * 1000 : 0)),
		accepted: m.submitted === 0 ? DASH : `${m.accepted} / ${m.submitted}`,
		acceptedCount: String(m.accepted ?? 0),
		ratio: snapshot.acceptedRatio == null ? DASH : `${num(snapshot.acceptedRatio, 2)}%`,
		rejected: String(m.rejected ?? 0),
		difficulty: m.difficulty == null ? DASH : String(m.difficulty),
		lastAccepted: m.lastAcceptedAt ? timestamp(m.lastAcceptedAt) : DASH,
		user: snapshot.miner.user || "",
		wallet: snapshot.miner.wallet || "",
		worker: snapshot.miner.worker || null,
		algo: (m.algorithms && m.algorithms.length > 0)
			? m.algorithms.map((a) => a.name).join(", ")
			: (snapshot.miner.algo || ""),
		pool: cleanPoolAddress(
			(m.algorithms && m.algorithms[0] && m.algorithms[0].pool && m.algorithms[0].pool.address)
				? m.algorithms[0].pool.address
				: (snapshot.miner.pool || "")
		),
		host: snapshot.host.hostname || "",
	};
}
export function presentGpu(gpu, opts = {}) {
	const levels = opts.tempLevels || { warn: 72, hot: 80 };
	const eff = gpu.hashrate > 0 && gpu.powerW > 0 ? gpu.hashrate / gpu.powerW : null;
	const effParsed = formatEfficiency(eff);
	const util = gpu.utilizationPct == null ? 0 : Math.max(0, Math.min(100, gpu.utilizationPct));
	return {
		name: `GPU ${gpu.index} \u2022 ${gpu.name || "Unknown"}`,
		pstate: gpu.pstate || DASH,
		temp: gpu.temperatureC != null ? `${num(gpu.temperatureC, 0)}\u00b0C` : DASH,
		tempStatus: tempStatus(gpu.temperatureC, levels),
		power: num(gpu.powerW, 1), core: num(gpu.coreMHz, 0), mem: num(gpu.memoryMHz, 0),
		vramUsed: num(gpu.memoryUsedMB, 0), vramTotal: num(gpu.memoryTotalMB, 0),
		hashrate: formatHashrate(gpu.hashrate),
		eff: effParsed.value, effUnit: effParsed.unit, effFormatted: effParsed.text,
		util: num(gpu.utilizationPct, 0), barScale: util / 100,
	};
}
