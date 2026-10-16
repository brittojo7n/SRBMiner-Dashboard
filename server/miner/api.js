const http = require("node:http");
const { Poller } = require("../utils/timers");
const { STATUS, LOG, LIMITS } = require("../utils/constants");
const { normalizePci } = require("./devices");
const { fetchSmiData } = require("./nvidia_smi");
const { parseMinerWallet, cleanPoolAddress } = require("../../web/lib/user");

const NUM_RE = /\d+/;

class ApiManager extends Poller {
	constructor({ state, port, pollMs = 2000, minerManager, hasViewers, onUpdate } = {}) {
		super({ state, pollMs, onUpdate });
		this.port = port;
		this.minerManager = minerManager || null;
		this.hasViewers = hasViewers || null;
		this.apiOnline = false;
		this.failCount = 0;
	}

	_onApiCrash(msg) {
		if (!this.minerManager || this.minerManager.isBusy) return;
		this.state.miner.lastError = msg;
		this.minerManager.pushLog(`${msg}; restarting miner immediately.`, LOG.ERROR);
		this.minerManager.autoRestart();
	}

	_onApiError() {
		if (!this.minerManager || this.minerManager.isBusy) return;
		if (this.apiOnline) {
			this.failCount++;
			if (this.failCount >= 2 || this.state.mining.status === STATUS.IDLE) {
				this.apiOnline = false;
				this.failCount = 0;
				this._onApiCrash("Miner API became inaccessible");
			}
		}
	}

	_poll() {
		if (!this.running) return;
		if (this.busy || !this.state.miner.running) {
			if (!this.state.miner.running) {
				this.apiOnline = false;
				this.failCount = 0;
			}
			this._schedule();
			return;
		}
		this.busy = true;
		const req = http.request({
			hostname: "127.0.0.1",
			port: this.port,
			path: "/",
			method: "GET",
			timeout: 2500,
		}, (res) => {
			let data = "";
			res.setEncoding("utf8");
			res.on("data", (c) => { data += c; });
			res.on("end", async () => {
				if (!this.running) {
					this.busy = false;
					return;
				}
				if (res.statusCode === 404 || res.statusCode >= 400) {
					this.busy = false;
					this._onApiCrash(`Miner API returned HTTP ${res.statusCode}`);
					this._schedule();
					return;
				}
				this.apiOnline = true;
				this.failCount = 0;
				if (data) {
					try { await this._updateState(JSON.parse(data)); } catch {}
				} else if (
					this.state.mining.status === STATUS.IDLE ||
					Date.now() - (this.state.miner.startedAt || Date.now()) > LIMITS.IDLE_SETTLE_MS
				) {
					this._syncHealth({}, 0, 0);
					this._notify();
				}
				this.busy = false;
				this._schedule();
			});
		});
		req.on("error", () => {
			this.busy = false;
			if (this.running) {
				this._onApiError();
				this._schedule();
			}
		});
		req.on("timeout", () => req.destroy());
		req.end();
	}

	_syncHealth(json, totalCpuHr, totalGpuHr) {
		if (this.minerManager && this.minerManager.isBusy) return;
		const mining = this.state.mining;
		const s = mining.status;
		if (s === STATUS.STOPPED || s === STATUS.STOPPING || s === STATUS.RESTARTING) return;

		const now = Date.now();
		if (mining.dagBuilding && now - (mining.dagStartedAt || 0) > LIMITS.DAG_TIMEOUT_MS) {
			mining.dagBuilding = false;
		}

		const gpuExpected = (json.total_gpu_workers || 0) > 0;
		const cpuExpected = (json.total_cpu_workers || 0) > 0;
		const isZero =
			mining.hashrateTotal <= 0 ||
			(gpuExpected && totalGpuHr <= 0) ||
			(cpuExpected && totalCpuHr <= 0);

		if (!isZero) {
			mining.dagBuilding = false;
			mining.zeroPings = 0;
		}

		if (s === STATUS.IDLE) {
			const settleMs = (this.minerManager && this.minerManager.timeouts.settle) ?? LIMITS.IDLE_SETTLE_MS;
			const elapsed = now - (mining.idleSince || now);
			if (isZero) {
				mining.idleZeroSeen = true;
				mining.positivePings = 0;
				mining.hashrateTotal = 0;
				mining.hashrateKHs = null;
				if (gpuExpected && totalGpuHr <= 0) mining.hashrateGpu = 0;
				if (cpuExpected && totalCpuHr <= 0) mining.hashrateCpu = 0;
				if (mining.restartAt && now >= mining.restartAt && this.minerManager) {
					this.minerManager.pushLog("Watchdog: Miner did not recover within grace period; restarting.", LOG.WARN);
					this.minerManager.autoRestart();
				}
				return;
			}
			mining.positivePings = (mining.positivePings || 0) + 1;
			if (elapsed < settleMs) {
				return;
			}
			if (mining.idleZeroSeen || mining.positivePings >= LIMITS.IDLE_ZERO_PINGS) {
				if (this.minerManager) this.minerManager.clearIdle(true);
				else {
					mining.status = STATUS.MINING;
					mining.idleSince = null;
					mining.restartAt = null;
					this.state.miner.lastError = "";
				}
				return;
			}
			if (mining.restartAt && now >= mining.restartAt && this.minerManager) {
				this.minerManager.pushLog("Watchdog: Miner did not recover within grace period; restarting.", LOG.WARN);
				this.minerManager.autoRestart();
			}
			return;
		}

		if (isZero) {
			if (mining.dagBuilding || s === STATUS.DISCONNECTED || s === STATUS.WAITING) return;
			mining.zeroPings = (mining.zeroPings || 0) + 1;
			if (mining.zeroPings >= LIMITS.IDLE_ZERO_PINGS) {
				if (this.minerManager) {
					this.minerManager.enterIdle(this.state.miner.lastError || "Miner hashrate dropped to 0");
				} else {
					mining.status = STATUS.IDLE;
					mining.idleSince = now;
					mining.restartAt = now + LIMITS.IDLE_TIMEOUT_MS;
					mining.idleZeroSeen = true;
				}
			}
			return;
		}

		mining.status = STATUS.MINING;
	}

	async _updateState(json) {
		let changed = false;
		const mining = this.state.mining;
		let totalCpuHr = 0, totalGpuHr = 0;

		if (json.rig_name && !mining.rigName) mining.rigName = json.rig_name;
		if (json.miner_version) mining.minerVersion = json.miner_version;

		if (Array.isArray(json.algorithms) && json.algorithms.length > 0) {
			let totalAcc = 0, totalRej = 0, totalHr = 0, hasDeviceHr = false;

			mining.gpuHashrates = Object.create(null);
			mining.gpuAlgos = Object.create(null);

			mining.algorithms = json.algorithms.map((algo, idx) => {
				const pool = algo.pool || {};
				const shares = algo.shares || {};
				const hr = algo.hashrate || {};
				const cpuHr = hr.cpu || {};
				const gpuHr = hr.gpu || {};
				if (hr.cpu !== undefined || hr.gpu !== undefined) hasDeviceHr = true;
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
							mining.gpuHashrates[key] = (mining.gpuHashrates[key] || 0) + val;
							const numMatch = NUM_RE.exec(key);
							let id = null;
							if (numMatch) {
								id = numMatch[0];
								mining.gpuHashrates[`cu_${id}`] = mining.gpuHashrates[key];
								mining.gpuHashrates[`cl_${id}`] = mining.gpuHashrates[key];
								mining.gpuHashrates[id] = mining.gpuHashrates[key];
							}
							
							const algoName = algo.name || `Algo ${idx}`;
							const actualId = id !== null ? id : key;
							if (!mining.gpuAlgos[actualId]) mining.gpuAlgos[actualId] = [];
							if (!mining.gpuAlgos[actualId].includes(algoName)) {
								mining.gpuAlgos[actualId].push(algoName);
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

			mining.accepted = totalAcc;
			mining.rejected = totalRej;
			mining.submitted = mining.accepted + mining.rejected;
			mining.hashrateCpu = totalCpuHr;
			mining.hashrateGpu = totalGpuHr;
			mining.hashrateTotal = hasDeviceHr ? (totalCpuHr + totalGpuHr) : totalHr;
			mining.hashrateKHs = mining.hashrateTotal > 0 ? mining.hashrateTotal / 1000 : null;

			for (let idx = 0; idx < json.algorithms.length; idx++) {
				const algo = json.algorithms[idx];
				const pool = algo.pool || {};
				const hasConsoleLat = mining.consoleLatencies && mining.consoleLatencies[idx] != null;
				if (!hasConsoleLat && pool.latency != null && Number.isFinite(pool.latency) && pool.latency >= 0) {
					if (!mining.apiLatencies) mining.apiLatencies = Object.create(null);
					mining.apiLatencies[idx] = pool.latency;
				}
				if (!mining.poolStates) mining.poolStates = Object.create(null);
				if (!mining.poolStates[idx] || mining.poolStates[idx] === "connecting") {
					if (pool.latency != null || (pool.time_connected && pool.time_connected !== "0") || pool.uptime > 0) {
						mining.poolStates[idx] = "connected";
					}
				}
			}

			const primary = mining.algorithms[0];
			if (primary && primary.pool) {
				if (primary.pool.difficulty != null && primary.pool.difficulty > 0) mining.difficulty = primary.pool.difficulty;
				const hasConsolePrimary = mining.consoleLatencies && mining.consoleLatencies[0] != null;
				if (!hasConsolePrimary && primary.pool.latency != null && Number.isFinite(primary.pool.latency) && primary.pool.latency >= 0) {
					mining.poolLatency = primary.pool.latency;
				} else if (hasConsolePrimary) {
					mining.poolLatency = mining.consoleLatencies[0];
				}
				if (primary.pool.wallet && !this.state.miner.wallet) {
					const w = parseMinerWallet(primary.pool.wallet);
					if (w) this.state.miner.wallet = w;
				}
			}

			changed = true;
		}

		this._syncHealth(json, totalCpuHr, totalGpuHr);

		if (json.total_cpu_workers > 0 && Array.isArray(json.cpu_devices) && json.cpu_devices.length > 0) {
			let aggCpuHr = 0;
			const aggThreads = {};
			const cpuAlgos = [];
			if (Array.isArray(json.algorithms)) {
				for (let i = 0; i < json.algorithms.length; i++) {
					const a = json.algorithms[i];
					const aCpu = a.hashrate && a.hashrate.cpu;
					if (aCpu) {
						const hrVal = aCpu.total || 0;
						aggCpuHr += hrVal;
						for (const k in aCpu) {
							if (k !== "total") aggThreads[k] = (aggThreads[k] || 0) + aCpu[k];
						}
						if (hrVal > 0 || Object.keys(aCpu).length > 1 || (a.cpu_power != null && a.cpu_power > 0)) {
							const aName = a.name || `Algo ${i}`;
							if (!cpuAlgos.includes(aName)) cpuAlgos.push(aName);
						}
					}
				}
				if (cpuAlgos.length === 0 && json.algorithms.length > 0) {
					const candidate = json.algorithms.find((a) => a.hashrate && a.hashrate.cpu && Object.keys(a.hashrate.cpu).length > 0);
					if (candidate && candidate.name) cpuAlgos.push(candidate.name);
					else if (json.algorithms.length === 1 && json.algorithms[0].name) cpuAlgos.push(json.algorithms[0].name);
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
				algos: cpuAlgos,
			}));
			changed = true;
		} else if (this.state.cpu.length > 0) {
			this.state.cpu = [];
			changed = true;
		}

		if (Array.isArray(json.gpu_devices)) {
			const hasNvidia = json.gpu_devices.some((d) => String(d.vendor).toLowerCase() === "nvidia");
			let smiData = null;
			if (hasNvidia && (!this.hasViewers || this.hasViewers())) {
				smiData = await fetchSmiData();
			}

			const gpus = [];
			for (let i = 0; i < json.gpu_devices.length; i++) {
				const dev = json.gpu_devices[i];
				if (dev.topology_id) {
					this.state.mining.pciMap[normalizePci(dev.topology_id)] = dev.id;
				}
				const minerGpuId = dev.id != null ? dev.id : i;
				const pciBusId = dev.topology_id ? normalizePci(dev.topology_id) : "";
				
				let smi = null;
				if (smiData && String(dev.vendor).toLowerCase() === "nvidia") {
					smi = smiData[pciBusId];
					if (!smi && dev.bus_id != null) {
						let b = dev.bus_id.toString(16).padStart(2, '0');
						smi = smiData[b];
					}
				}

				gpus.push({
					index: minerGpuId,
					minerId: minerGpuId,
					name: dev.model || `GPU ${minerGpuId}`,
					temperatureC: dev.temperature || null,
					powerW: dev.asic_power ?? dev.power_usage ?? null,
					coreMHz: dev.core_clock || null,
					memoryMHz: dev.memory_clock || null,
					pciBusId,
					memoryUsedMB: smi ? smi.memoryUsedMB : null,
					memoryTotalMB: smi ? smi.memoryTotalMB : null,
					utilizationPct: smi ? smi.utilizationPct : null,
					pstate: smi ? smi.pstate : null,
				});
			}
			gpus.sort((a, b) => a.index - b.index);
			this.state.gpu = gpus;
			changed = true;
		}

		if (changed) this._notify();
	}

	stop() {
		super.stop();
		this.apiOnline = false;
		this.failCount = 0;
		this.state.mining.apiLatencies = Object.create(null);
		this.state.mining.consoleLatencies = Object.create(null);
		this.state.mining.poolStates = Object.create(null);
		this.state.mining.poolLatency = null;
		if (this.state.cpu.length > 0) {
			this.state.cpu = [];
		}
		this._notify();
	}
}

module.exports = { ApiManager };
