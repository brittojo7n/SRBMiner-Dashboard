const { STATUS, LOG } = require("../utils/constants");
const { stripAnsi } = require("./devices");

const RX_SRB_SHARE_ACC = /(?:CPU|GPU\d*)\s+share\s+accepted(?:\s*\[\s*(\d+)ms\])?/i;
const RX_SRB_SHARE_REJ = /(?:CPU|GPU\d*)\s+share\s+rejected(?:\s*\[([^\]]+)\])?/i;
const RX_SRB_TOTAL = /Total:\s*([\d.]+)\s*([kKMGT]?H\/s)(?:\s*\[.*?A:(\d+)\s+R:(\d+).*?\])?/i;
const RX_SRB_DIFF = /Diff:\s*([+-]?[\d.]+(?:[eE][+-]?\d+)?)/i;
const RX_SRB_LATENCY = /Latency:\s*~?(\d+)\s*ms/i;
const RX_SRB_CONNECTED = /Connected to\s*([^\s]+)/i;
const RX_DIFF = /difficulty(?:\s*(?:set|is))?\s*(?:to|:)?\s*([+-]?[\d.]+(?:[eE][+-]?\d+)?)/i;
const RX_FATAL = /\b(?:cuda\s+error|failed\s+to|fatal|exception|enoent|out\s+of\s+memory)\b/i;
const RX_POOL_DOWN = /stratum[\s_](?:connection\s+(?:failed|timed\s+out|interrupted)|recv_line\s+(?:timed\s+out|failed)|subscribe\s+(?:send\s+)?(?:failed|timed\s+out)|send_line\s+failed|authentication\s+failed|thread\s+create\s+failed)|json_rpc_call\s+failed|pool\s+connection\s+lost/i;

function toHashrateHz(val, unit) {
	const u = (unit || "").charCodeAt(0) | 32;
	if (u === 107) return val * 1e3;
	if (u === 109) return val * 1e6;
	if (u === 103) return val * 1e9;
	if (u === 116) return val * 1e12;
	return val;
}

function canSetRunStatus(state) {
	const s = state.mining.status;
	return Boolean(state.miner && state.miner.running && s !== STATUS.RESTARTING && s !== STATUS.STOPPING && s !== STATUS.STOPPED);
}

function emitLog(state, pushLog, text, type) {
	if (typeof pushLog === "function") {
		pushLog(text, type);
		return;
	}
	if (state.miner.logs) {
		state.miner.logs.push(text, type);
		state.miner.lastLine = text;
		state.dirty = true;
	}
}

function parseMinerLine(raw, state, pushLog) {
	const source = typeof raw === "string" ? raw : String(raw);
	const clean = source.indexOf("\u001b") === -1 ? source : stripAnsi(source);
	const line = clean.trim();
	if (!line) return;

	const mining = state.mining;
	let isFatal = false;
	let isPoolDown = false;
	let type = LOG.INFO;

	const srbAccMatch = RX_SRB_SHARE_ACC.exec(line);
	const srbRejMatch = !srbAccMatch && RX_SRB_SHARE_REJ.exec(line);
	const totalMatch = !srbAccMatch && !srbRejMatch && RX_SRB_TOTAL.exec(line);
	const connMatch = !srbAccMatch && !srbRejMatch && !totalMatch && RX_SRB_CONNECTED.exec(line);

	if (RX_POOL_DOWN.test(line)) {
		isFatal = true;
		isPoolDown = true;
		type = LOG.ERROR;
	} else if (RX_FATAL.test(line)) {
		isFatal = true;
		type = LOG.ERROR;
	} else if (srbAccMatch) {
		type = LOG.SUCCESS;
	} else if (srbRejMatch) {
		type = LOG.ERROR;
	} else if (connMatch) {
		type = LOG.SUCCESS;
	} else {
		const lc = line.toLowerCase();
		if (/(?:accepted:|share accepted|verified succes)/.test(lc) || lc.includes("connected to")) {
			type = LOG.SUCCESS;
		} else if (lc.includes("share rejected") || /(?:error|failed|rejected)/.test(lc)) {
			type = LOG.ERROR;
		} else if (/(?:stratum|diff:|difficulty|latency:|average hashrate|total:|pool:)/.test(lc)) {
			type = LOG.ACCENT;
		} else if (/(?:warn|warning)/.test(lc)) {
			type = LOG.WARN;
		}
	}

	if (isFatal && canSetRunStatus(state)) {
		state.miner.lastError = line;
		mining.status = isPoolDown ? STATUS.DISCONNECTED : STATUS.CRASHED;
		state.dirty = true;
	}

	emitLog(state, pushLog, line, type);

	if (srbAccMatch) {
		mining.accepted = (mining.accepted || 0) + 1;
		mining.submitted = (mining.submitted || 0) + 1;
		mining.lastAcceptedAt = Date.now();
		if (srbAccMatch[1]) mining.poolLatency = Number(srbAccMatch[1]);
		if (canSetRunStatus(state)) {
			mining.status = STATUS.MINING;
			state.miner.lastError = "";
		}
		state.dirty = true;
	} else if (srbRejMatch) {
		mining.rejected = (mining.rejected || 0) + 1;
		mining.submitted = (mining.submitted || 0) + 1;
		state.dirty = true;
	} else if (totalMatch) {
		const hz = toHashrateHz(Number(totalMatch[1]), totalMatch[2]);
		if (Number.isFinite(hz)) {
			mining.hashrateTotal = hz;
			mining.hashrateKHs = hz / 1000;
		}
		if (totalMatch[3] && totalMatch[4]) {
			mining.accepted = Number(totalMatch[3]);
			mining.rejected = Number(totalMatch[4]);
			mining.submitted = mining.accepted + mining.rejected;
		}
		if (canSetRunStatus(state)) {
			mining.status = STATUS.MINING;
			state.miner.lastError = "";
		}
		state.dirty = true;
	} else if (connMatch) {
		if (canSetRunStatus(state) && mining.status !== STATUS.MINING) {
			mining.status = STATUS.CONNECTED;
			state.dirty = true;
		}
	}

	const diffMatch = RX_SRB_DIFF.exec(line) || RX_DIFF.exec(line);
	if (diffMatch) {
		const diffVal = Number(diffMatch[1]);
		if (Number.isFinite(diffVal)) {
			mining.difficulty = diffVal;
			state.dirty = true;
		}
	}

	const latMatch = RX_SRB_LATENCY.exec(line);
	if (latMatch) {
		const latVal = Number(latMatch[1]);
		if (Number.isFinite(latVal)) {
			mining.poolLatency = latVal;
			state.dirty = true;
		}
	}
}

module.exports = { parseMinerLine };
