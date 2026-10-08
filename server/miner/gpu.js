"use strict";
const { execFile } = require("node:child_process");
const { LIMITS } = require("../utils/constants");
const { normalizePci } = require("./devices");
const { Poller } = require("../utils/timers");
const SMI_QUERY = Object.freeze(["--query-gpu=name,temperature.gpu,power.draw,utilization.gpu,clocks.gr,clocks.mem,memory.used,memory.total,pstate,pci.bus_id", "--format=csv,noheader,nounits"]);
const SMI_BIN = process.platform === "win32" ? "nvidia-smi.exe" : "nvidia-smi";
const EXEC_TIMEOUT_MS = 1500;
function toNumber(value) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}
class GpuManager extends Poller {
  constructor({ state, pollMs, onUpdate, exec = execFile } = {}) {
    super({ state, pollMs, onUpdate });
    this.exec = exec;
  }
  _poll() {
    if (!this.running) return;
    if (this.busy) {
      this._schedule();
      return;
    }
    this.busy = true;
    this.exec(SMI_BIN, SMI_QUERY, { windowsHide: true, timeout: EXEC_TIMEOUT_MS, maxBuffer: LIMITS.GPU_MAX_BUFFER_BYTES }, (err, stdout) => {
      this.busy = false;
      if (!this.running) return;

      if (!err && stdout && String(stdout).trim()) {
        const trimmed = String(stdout).trim();
        const lines = trimmed.split("\n");
        this.state.gpuError = "";
        let validCount = 0;
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          if (!line) continue;
          const p = line.split(",");
          const pciBusId = normalizePci((p[9] || "").trim());
          const name = (p[0] || "").trim() || `GPU ${validCount}`;
          const temperatureC = toNumber(p[1]);
          const powerW = toNumber(p[2]);
          const utilizationPct = toNumber(p[3]);
          const coreMHz = toNumber(p[4]);
          const memoryMHz = toNumber(p[5]);
          const memoryUsedMB = toNumber(p[6]);
          const memoryTotalMB = toNumber(p[7]);
          const pstate = (p[8] || "").trim() || null;
          if (validCount < this.state.gpu.length) {
            const g = this.state.gpu[validCount];
            g.name = name; g.temperatureC = temperatureC; g.powerW = powerW; g.utilizationPct = utilizationPct; g.coreMHz = coreMHz; g.memoryMHz = memoryMHz; g.memoryUsedMB = memoryUsedMB; g.memoryTotalMB = memoryTotalMB; g.pstate = pstate; g.pciBusId = pciBusId;
          } else {
            this.state.gpu.push({ index: validCount, name, temperatureC, powerW, utilizationPct, coreMHz, memoryMHz, memoryUsedMB, memoryTotalMB, pstate, pciBusId });
          }
          validCount++;
        }
        if (this.state.gpu.length > validCount) {
          this.state.gpu.length = validCount;
        }
        this._notify();
      } else {
        if (err) {
          const message = err.message || String(err);
          if (this.state.gpuError !== message) {
            this.state.gpuError = message;
          }
        }
        if (this.state.apiGpuDevices && this.state.apiGpuDevices.length > 0) {
          let validCount = 0;
          for (const apiGpu of this.state.apiGpuDevices) {
            const name = apiGpu.model || `GPU ${apiGpu.id}`;
            const temperatureC = apiGpu.temperature || null;
            const powerW = apiGpu.power_usage || null;
            if (validCount < this.state.gpu.length) {
              const g = this.state.gpu[validCount];
              g.name = name; g.temperatureC = temperatureC; g.powerW = powerW;
            } else {
              this.state.gpu.push({ index: validCount, name, temperatureC, powerW });
            }
            validCount++;
          }
          if (this.state.gpu.length > validCount) {
            this.state.gpu.length = validCount;
          }
        } else if (this.state.gpu.length > 0) {
          this.state.gpu.length = 0;
        }
        this._notify();
      }

      if (this.running) {
        this._schedule();
      }
    });
  }
  stop() {
    super.stop();
    if (this.state.gpu.length > 0 || this.state.gpuError) {
      this.state.gpu = [];
      this.state.gpuError = "";
      this._notify();
    }
  }
}
module.exports = { GpuManager };
