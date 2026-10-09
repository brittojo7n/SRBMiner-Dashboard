const { execFile } = require("node:child_process");
const { LIMITS } = require("../utils/constants");
const { normalizePci } = require("./devices");
const { Poller } = require("../utils/timers");

const SMI_QUERY = Object.freeze([
	"--query-gpu=name,temperature.gpu,power.draw,utilization.gpu,clocks.gr,clocks.mem,memory.used,memory.total,pstate,pci.bus_id",
	"--format=csv,noheader,nounits",
]);
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
				const lines = String(stdout).trim().split("\n");
				this.state.gpuError = "";
				const smiGpus = [];
				for (let i = 0; i < lines.length; i++) {
					const line = lines[i].trim();
					if (!line) continue;
					const p = line.split(",");
					const pciBusId = normalizePci((p[9] || "").trim());
					const name = (p[0] || "").trim() || `GPU ${smiGpus.length}`;
					const temperatureC = toNumber(p[1]);
					const powerW = toNumber(p[2]);
					const utilizationPct = toNumber(p[3]);
					const coreMHz = toNumber(p[4]);
					const memoryMHz = toNumber(p[5]);
					const memoryUsedMB = toNumber(p[6]);
					const memoryTotalMB = toNumber(p[7]);
					const pstate = (p[8] || "").trim() || null;
					smiGpus.push({
						index: smiGpus.length,
						name,
						temperatureC,
						powerW,
						utilizationPct,
						coreMHz,
						memoryMHz,
						memoryUsedMB,
						memoryTotalMB,
						pstate,
						pciBusId,
					});
				}

				const pciMap = this.state.mining.pciMap || {};
				const apiDevs = this.state.apiGpuDevices || [];
				let orderedGpus = [];

				if (apiDevs.length > 0) {
					const usedSmi = new Set();
					for (let i = 0; i < apiDevs.length; i++) {
						const dev = apiDevs[i];
						const devPci = dev.topology_id ? normalizePci(dev.topology_id) : "";
						const smiMatch = smiGpus.find((g, idx) => !usedSmi.has(idx) && (devPci ? g.pciBusId === devPci : g.index === dev.id));
						const minerGpuId = dev.id != null ? dev.id : i;
						if (smiMatch) {
							usedSmi.add(smiGpus.indexOf(smiMatch));
							orderedGpus.push({
								...smiMatch,
								index: minerGpuId,
								minerId: minerGpuId,
							});
						} else {
							orderedGpus.push({
								index: minerGpuId,
								minerId: minerGpuId,
								name: dev.model || `GPU ${minerGpuId}`,
								temperatureC: dev.temperature || null,
								powerW: dev.asic_power ?? dev.power_usage ?? null,
								coreMHz: dev.core_clock || null,
								memoryMHz: dev.memory_clock || null,
								pciBusId: devPci,
							});
						}
					}
					for (let i = 0; i < smiGpus.length; i++) {
						if (!usedSmi.has(i)) {
							const g = smiGpus[i];
							const mappedId = pciMap[g.pciBusId];
							const minerId = mappedId != null ? Number(mappedId) : g.index;
							orderedGpus.push({ ...g, index: minerId, minerId });
						}
					}
				} else {
					orderedGpus = smiGpus.map((g) => {
						const mappedId = pciMap[g.pciBusId];
						const minerId = mappedId != null ? Number(mappedId) : g.index;
						return { ...g, index: minerId, minerId };
					});
				}

				orderedGpus.sort((a, b) => a.index - b.index);

				this.state.gpu = orderedGpus;
				this._notify();
			} else {
				if (err) {
					const message = err.message || String(err);
					if (this.state.gpuError !== message) this.state.gpuError = message;
				}
				const apiDevs = this.state.apiGpuDevices;
				if (apiDevs && apiDevs.length > 0) {
					this.state.gpuError = "";
					const fallbackGpus = [];
					for (let i = 0; i < apiDevs.length; i++) {
						const apiGpu = apiDevs[i];
						const minerGpuId = apiGpu.id != null ? apiGpu.id : i;
						const name = apiGpu.model || `GPU ${minerGpuId}`;
						const temperatureC = apiGpu.temperature || null;
						const powerW = apiGpu.asic_power ?? apiGpu.power_usage ?? null;
						const coreMHz = apiGpu.core_clock || null;
						const memoryMHz = apiGpu.memory_clock || null;
						const pciBusId = apiGpu.topology_id ? normalizePci(apiGpu.topology_id) : "";
						fallbackGpus.push({
							index: minerGpuId,
							minerId: minerGpuId,
							name,
							temperatureC,
							powerW,
							coreMHz,
							memoryMHz,
							pciBusId,
							fromApiOnly: true,
						});
					}
					fallbackGpus.sort((a, b) => a.index - b.index);
					this.state.gpu = fallbackGpus;
				} else if (this.state.gpu.length > 0) {
					this.state.gpu.length = 0;
				}
				this._notify();
			}

			if (this.running) this._schedule();
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
