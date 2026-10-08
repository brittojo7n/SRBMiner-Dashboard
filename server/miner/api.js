"use strict";
const http = require("node:http");
const { Poller } = require("../utils/timers");
const { STATUS } = require("../utils/constants");

class ApiManager extends Poller {
  constructor({ state, port, pollMs = 2000, onUpdate } = {}) {
    super({ state, pollMs, onUpdate });
    this.port = port;
  }

  _poll() {
    if (!this.running) return;
    if (this.busy) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = unrefTimer(() => this._poll(), this.pollMs);
      return;
    }
    
    if (!this.state.miner.running) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = unrefTimer(() => this._poll(), this.pollMs);
      return;
    }

    this.busy = true;
    
    const req = http.request({
      hostname: "127.0.0.1",
      port: this.port,
      path: "/",
      method: "GET",
      timeout: 1500
    }, (res) => {
      let data = "";
      res.on("data", chunk => { data += chunk; });
      res.on("end", () => {
        this.busy = false;
        if (!this.running) return;
        
        try {
          const json = JSON.parse(data);
          this._updateState(json);
        } catch (e) {}
        
        this._schedule();
      });
    });

    req.on("error", () => {
      this.busy = false;
      this._schedule();
    });
    
    req.on("timeout", () => {
      req.destroy();
    });

    req.end();
  }

  _updateState(json) {
    let changed = false;
    const mining = this.state.mining;

    if (json.rig_name && !mining.rigName) {
      mining.rigName = json.rig_name;
    }
    if (json.miner_version) {
      mining.minerVersion = json.miner_version;
    }

    if (Array.isArray(json.algorithms) && json.algorithms.length > 0) {
      let totalAccepted = 0;
      let totalRejected = 0;
      let totalHashrate = 0;
      let totalCpuHashrate = 0;
      let totalGpuHashrate = 0;

      const parsedAlgorithms = json.algorithms.map((algo, idx) => {
        const pool = algo.pool || {};
        const shares = algo.shares || {};
        const hr = algo.hashrate || {};
        const cpuHr = hr.cpu || {};
        const gpuHr = hr.gpu || {};

        const oneMin = hr["1min"] || 0;
        const accepted = shares.accepted || 0;
        const rejected = shares.rejected || 0;

        totalAccepted += accepted;
        totalRejected += rejected;
        totalHashrate += oneMin;
        totalCpuHashrate += (cpuHr.total || 0);
        totalGpuHashrate += (gpuHr.total || 0);

        return {
          id: algo.id ?? idx,
          name: algo.name || `Algo ${idx}`,
          pool: {
            address: pool.pool || "",
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

      mining.algorithms = parsedAlgorithms;
      mining.accepted = totalAccepted;
      mining.rejected = totalRejected;
      mining.submitted = totalAccepted + totalRejected;
      mining.hashrateTotal = totalHashrate;
      mining.hashrateCpu = totalCpuHashrate;
      mining.hashrateGpu = totalGpuHashrate;

      const primary = parsedAlgorithms[0];
      if (primary && primary.pool) {
        if (primary.pool.difficulty != null) mining.difficulty = primary.pool.difficulty;
        if (primary.pool.latency != null) mining.poolLatency = primary.pool.latency;
        if (mining.status !== STATUS.STOPPED && mining.status !== STATUS.STOPPING) {
          mining.status = STATUS.MINING;
        }
      }

      changed = true;
    }

    if (Array.isArray(json.cpu_devices) && json.cpu_devices.length > 0) {
      this.state.cpu = json.cpu_devices.map((cpu, idx) => {
        let cpuHr = 0;
        let threads = {};

        if (Array.isArray(json.algorithms)) {
          for (const algo of json.algorithms) {
            if (algo.hashrate && algo.hashrate.cpu) {
              cpuHr += algo.hashrate.cpu.total || 0;
              for (const [k, v] of Object.entries(algo.hashrate.cpu)) {
                if (k !== "total") {
                  threads[k] = (threads[k] || 0) + v;
                }
              }
            }
          }
        }

        return {
          id: cpu.id ?? idx,
          name: cpu.model || cpu.device || `CPU ${idx}`,
          l1: cpu.L1,
          l2: cpu.L2,
          l3: cpu.L3,
          packagePowerW: cpu.package_power || 0,
          hashrate: cpuHr,
          threads,
        };
      });
      changed = true;
    }

    if (Array.isArray(json.gpu_devices)) {
      this.state.apiGpuDevices = json.gpu_devices;
      changed = true;
    }

    if (changed) this._notify();
  }
}

module.exports = { ApiManager };
