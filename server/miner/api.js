const http = require("node:http");
const { Poller } = require("../utils/timers");
const { STATUS } = require("../utils/constants");
const { normalizePci } = require("./devices");
const { parseMinerUser, cleanPoolAddress } = require("../../web/lib/user");

const NUM_RE = /\d+/;

class ApiManager extends Poller {
	constructor({ state, port, pollMs = 2000, onUpdate } = {}) {
		super({ state, pollMs, onUpdate });
		this.port = port;
	}

	_poll() {
		if (!this.running) return;
		if (this.busy || !this.state.miner.running) {
			this._schedule();
			return;
		}
		this.busy = true;
		const req = http.request({
			hostname: "127.0.0.1",
			port: this.port,
			path: "/",
			method: "GET",
			timeout: 1500,
		}, (res) => {
			let data = "";
			res.setEncoding("utf8");
			res.on("data", (c) => { data += c; });
			res.on("end", () => {
				this.busy = false;
				if (!this.running) return;
				try { this._updateState(JSON.parse(data)); } catch {}
				this._schedule();
			});
		});
		req.on("error", () => {
			this.busy = false;
			if (this.running) this._schedule();
		});
		req.on("timeout", () => req.destroy());
		req.end();
	}

	_updateState(json) {
		let changed = false;
		const mining = this.state.mining;

		if (json.rig_name && !mining.rigName) mining.rigName = json.rig_name;
		if (json.miner_version) mining.minerVersion = json.miner_version;

		if (Array.isArray(json.algorithms) && json.algorithms.length > 0) {
			let totalAcc = 0, totalRej = 0, totalHr = 0, totalCpuHr = 0, totalGpuHr = 0;

			mining.algorithms = json.algorithms.map((algo, idx) => {
				const pool = algo.pool || {};
				const shares = algo.shares || {};
				const hr = algo.hashrate || {};
				const cpuHr = hr.cpu || {};
				const gpuHr = hr.gpu || {};
				const oneMin = hr["1min"] || 0;
				const accepted = shares.accepted || 0;
				const rejected = shares.rejected || 0;

				totalAcc += accepted;
				totalRej += rejected;
				totalHr += oneMin;
				totalCpuHr += (cpuHr.total || 0);
				totalGpuHr += (gpuHr.total || 0);

				if (gpuHr) {
					for (const key in gpuHr) {
						if (key !== "total") {
							const val = gpuHr[key];
							mining.gpuHashrates[key] = val;
							const numMatch = NUM_RE.exec(key);
							if (numMatch) {
								const id = numMatch[0];
								mining.gpuHashrates[`cu_${id}`] = val;
								mining.gpuHashrates[`cl_${id}`] = val;
								mining.gpuHashrates[id] = val;
							}
						}
					}
				}

				return {
					id: algo.id ?? idx,
					name: algo.name || `Algo ${idx}`,
					pool: {
						address: cleanPoolAddress(pool.pool || ""),
						wallet: pool.wallet || "",
						difficulty: pool.difficulty ?? null,
						latency: pool.latency ?? null,
						uptime: pool.uptime || 0,
						lastJobReceived: pool.last_job_received ?? 0,
					},
					shares: {
						total: shares.total || (accepted + rejected),
						accepted,
						rejected,
						avgFindTime: shares.avg_find_time || 0,
					},
					hashrate: {
						oneMin,
						oneHour: hr["1hr"] || 0,
						sixHours: hr["6hr"] || 0,
						twelveHours: hr["12hr"] || 0,
						cpu: cpuHr,
						gpu: gpuHr,
					},
					cpuPower: algo.cpu_power || 0,
					cpuEfficiency: algo.cpu_efficiency?.total || 0,
					gpuComputeErrors: algo.gpu_compute_errors || {},
				};
			});

			mining.accepted = Math.max(mining.accepted || 0, totalAcc);
			mining.rejected = Math.max(mining.rejected || 0, totalRej);
			mining.submitted = mining.accepted + mining.rejected;
			mining.hashrateCpu = totalCpuHr;
			mining.hashrateGpu = totalGpuHr;
			mining.hashrateTotal = (totalCpuHr > 0 || totalGpuHr > 0)
				? (totalCpuHr + totalGpuHr)
				: totalHr;

			const primary = mining.algorithms[0];
			if (primary && primary.pool) {
				if (primary.pool.difficulty != null && primary.pool.difficulty > 0) mining.difficulty = primary.pool.difficulty;
				if (primary.pool.latency != null && primary.pool.latency > 0) mining.poolLatency = primary.pool.latency;
				if (primary.pool.wallet && (!this.state.miner.worker || !this.state.miner.wallet)) {
					const parsed = parseMinerUser(primary.pool.wallet);
					if (!this.state.miner.wallet && parsed.wallet) this.state.miner.wallet = parsed.wallet;
					if (!this.state.miner.worker && parsed.worker) this.state.miner.worker = parsed.worker;
				}
				if (mining.status !== STATUS.STOPPED && mining.status !== STATUS.STOPPING) {
					mining.status = STATUS.MINING;
				}
			}

			changed = true;
		}

		if (json.total_cpu_workers > 0 && Array.isArray(json.cpu_devices) && json.cpu_devices.length > 0) {
			let aggCpuHr = 0;
			const aggThreads = {};
			if (Array.isArray(json.algorithms)) {
				for (let i = 0; i < json.algorithms.length; i++) {
					const a = json.algorithms[i];
					if (a.hashrate && a.hashrate.cpu) {
						aggCpuHr += a.hashrate.cpu.total || 0;
						for (const k in a.hashrate.cpu) {
							if (k !== "total") aggThreads[k] = (aggThreads[k] || 0) + a.hashrate.cpu[k];
						}
					}
				}
			}

			this.state.cpu = json.cpu_devices.map((cpu, idx) => ({
				id: cpu.id ?? idx,
				name: cpu.model || cpu.device || `CPU ${idx}`,
				l1: cpu.L1,
				l2: cpu.L2,
				l3: cpu.L3,
				packagePowerW: cpu.package_power || 0,
				hashrate: aggCpuHr,
				threads: aggThreads,
			}));
			changed = true;
		} else if (this.state.cpu.length > 0) {
			this.state.cpu = [];
			changed = true;
		}

		if (Array.isArray(json.gpu_devices)) {
			this.state.apiGpuDevices = json.gpu_devices;
			for (let i = 0; i < json.gpu_devices.length; i++) {
				const dev = json.gpu_devices[i];
				if (dev.topology_id) {
					this.state.mining.pciMap[normalizePci(dev.topology_id)] = dev.id;
				}
			}
			if (!this.state.gpu || this.state.gpu.length === 0 || this.state.gpu.every((g) => g.fromApiOnly)) {
				const fallbackGpus = [];
				for (let i = 0; i < json.gpu_devices.length; i++) {
					const apiGpu = json.gpu_devices[i];
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
				if (this.state.gpuError) this.state.gpuError = "";
			}
			changed = true;
		}

		if (changed) this._notify();
	}

	stop() {
		super.stop();
		if (this.state.cpu.length > 0 || (this.state.apiGpuDevices && this.state.apiGpuDevices.length > 0)) {
			this.state.cpu = [];
			this.state.apiGpuDevices = [];
			this._notify();
		}
	}
}

module.exports = { ApiManager };
