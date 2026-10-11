const { execFile } = require("node:child_process");
const { normalizePci } = require("./devices");

const SMI_QUERY = Object.freeze([
	"--query-gpu=memory.used,memory.total,utilization.gpu,pstate,pci.bus_id",
	"--format=csv,noheader,nounits",
]);
const SMI_BIN = process.platform === "win32" ? "nvidia-smi.exe" : "nvidia-smi";
const EXEC_TIMEOUT_MS = 1500;

let smiDisabled = process.platform !== "win32" && process.platform !== "linux";

function fetchSmiData() {
	if (smiDisabled) return Promise.resolve(null);
	return new Promise((resolve) => {
		execFile(SMI_BIN, SMI_QUERY, { windowsHide: true, timeout: EXEC_TIMEOUT_MS }, (err, stdout) => {
			if (err) {
				if (err.code === "ENOENT" || (err.message && (err.message.includes("not found") || err.message.includes("not recognized")))) {
					smiDisabled = true;
				}
				return resolve(null);
			}
			const data = Object.create(null);
			const lines = String(stdout).trim().split("\n");
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i].trim();
				if (!line) continue;
				const p = line.split(",");
				if (p.length >= 5) {
					const memoryUsedMB = Number(p[0]) || null;
					const memoryTotalMB = Number(p[1]) || null;
					const utilizationPct = Number(p[2]) || null;
					const pstate = (p[3] || "").trim() || null;
					const pciBusId = normalizePci((p[4] || "").trim());
					data[pciBusId] = { memoryUsedMB, memoryTotalMB, utilizationPct, pstate };
					const busMatch = pciBusId.match(/:([0-9a-fA-F]{2}):/);
					if (busMatch) data[busMatch[1].toLowerCase()] = { memoryUsedMB, memoryTotalMB, utilizationPct, pstate };
				}
			}
			resolve(data);
		});
	});
}

module.exports = { fetchSmiData };
