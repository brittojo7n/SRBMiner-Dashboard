"use strict";

const { STATUS, LOG } = require("../utils/constants");
const { stripAnsi } = require("./devices");

const RX_SRB_SHARE_ACC = /(?:CPU|GPU\d*)\s+share\s+accepted(?:\s*\[\s*(\d+)ms\])?/i;
const RX_SRB_SHARE_REJ = /(?:CPU|GPU\d*)\s+share\s+rejected(?:\s*\[([^\]]+)\])?/i;
const RX_SRB_TOTAL = /Total:\s*([\d.]+)\s*([kKMGT]?H\/s)(?:\s*\[.*?A:(\d+)\s+R:(\d+).*?\])?/i;
const RX_SRB_DIFF = /Diff:\s*([+-]?[\d.]+(?:[eE][+-]?\d+)?)/i;
const RX_SRB_LATENCY = /Latency:\s*~?(\d+)\s*ms/i;
const RX_SRB_CONNECTED = /Connected to\s*([^\s]+)/i;
const RX_SRB_POOL = /Pool:\s*([^\s]+)/i;

const RX_DIFF = /difficulty(?:\s*(?:set|is))?\s*(?:to|:)?\s*([+-]?[\d.]+(?:[eE][+-]?\d+)?)/i;
const RX_FATAL = /\b(?:cuda\s+error|failed\s+to|fatal|exception|enoent|out\s+of\s+memory)\b/i;
const RX_POOL_DOWN = /stratum[\s_](?:connection\s+(?:failed|timed\s+out|interrupted)|recv_line\s+(?:timed\s+out|failed)|subscribe\s+(?:send\s+)?(?:failed|timed\s+out)|send_line\s+failed|authentication\s+failed|thread\s+create\s+failed)|json_rpc_call\s+failed|pool\s+connection\s+lost/i;

function toHashrateHz(val, unit) {
  const u = (unit || "").toLowerCase();
  if (u.startsWith("k")) return val * 1e3;
  if (u.startsWith("m")) return val * 1e6;
  if (u.startsWith("g")) return val * 1e9;
  if (u.startsWith("t")) return val * 1e12;
  return val;
}

function canSetRunStatus(state) {
  const status = state.mining.status;
  return Boolean(
    state.miner &&
      state.miner.running &&
      status !== STATUS.RESTARTING &&
      status !== STATUS.STOPPING &&
      status !== STATUS.STOPPED,
  );
}

function classifyLine(line, lc) {
  const base = { isFatal: false, isPoolDown: false };
  if (RX_POOL_DOWN.test(line)) {
    return { ...base, isFatal: true, isPoolDown: true, type: LOG.ERROR };
  }
  if (RX_FATAL.test(line)) {
    return { ...base, isFatal: true, type: LOG.ERROR };
  }
  if (RX_SRB_SHARE_ACC.test(line) || /(?:accepted:|share accepted|verified succes)/i.test(lc)) {
    return { ...base, type: LOG.SUCCESS };
  }
  if (RX_SRB_SHARE_REJ.test(line) || lc.includes("share rejected")) {
    return { ...base, type: LOG.ERROR };
  }
  if (RX_SRB_CONNECTED.test(line) || lc.includes("connected to")) {
    return { ...base, type: LOG.SUCCESS };
  }
  if (/(?:stratum|diff:|difficulty|latency:|average hashrate|total:|pool:)/i.test(lc)) {
    return { ...base, type: LOG.ACCENT };
  }
  if (/(?:error|failed|rejected)/i.test(lc)) {
    return { ...base, type: LOG.ERROR };
  }
  if (/(?:warn|warning)/i.test(lc)) {
    return { ...base, type: LOG.WARN };
  }
  return { ...base, type: LOG.INFO };
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
  const lc = line.toLowerCase();
  const { isFatal, isPoolDown, type } = classifyLine(line, lc);
  const mining = state.mining;

  if (isFatal && canSetRunStatus(state)) {
    state.miner.lastError = line;
    mining.status = isPoolDown ? STATUS.DISCONNECTED : STATUS.CRASHED;
    state.dirty = true;
  }

  emitLog(state, pushLog, line, type);

  const srbAccMatch = RX_SRB_SHARE_ACC.exec(line);
  if (srbAccMatch) {
    mining.accepted = (mining.accepted || 0) + 1;
    mining.submitted = (mining.submitted || 0) + 1;
    mining.lastAcceptedAt = Date.now();
    if (srbAccMatch[1]) {
      mining.poolLatency = Number(srbAccMatch[1]);
    }
    if (canSetRunStatus(state)) {
      mining.status = STATUS.MINING;
      state.miner.lastError = "";
    }
    state.dirty = true;
  }

  const srbRejMatch = RX_SRB_SHARE_REJ.exec(line);
  if (srbRejMatch) {
    mining.rejected = (mining.rejected || 0) + 1;
    mining.submitted = (mining.submitted || 0) + 1;
    state.dirty = true;
  }

  const totalMatch = RX_SRB_TOTAL.exec(line);
  if (totalMatch) {
    const rateVal = Number(totalMatch[1]);
    const rateUnit = totalMatch[2];
    const hz = toHashrateHz(rateVal, rateUnit);
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

  if (RX_SRB_CONNECTED.test(line) && canSetRunStatus(state) && mining.status !== STATUS.MINING) {
    mining.status = STATUS.CONNECTED;
    state.dirty = true;
  }
}

module.exports = { parseMinerLine };
