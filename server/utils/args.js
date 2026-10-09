const VALUE_FLAGS = {
	algo: ["-a", "--algorithm"],
	algoCpu: ["-ac", "--algorithm-cpu"],
	algoGpu: ["-ag", "--algorithm-gpu"],
	pool: ["-o", "--pool", "--server", "--url"],
	wallet: ["-u", "--wallet", "--user"],
	password: ["-p", "--password", "--pass"],
	cpuThreads: ["-t", "--cpu-threads"],
	cpuThreadsPriority: ["--cpu-threads-priority"],
	cpuThreadsIntensity: ["--cpu-threads-intensity"],
	cpuAffinity: ["--cpu-affinity"],
	apiPort: ["--api-port"],
	apiRigName: ["--api-rig-name"],
	gpuId: ["--gpu-id"],
	gpuIntensity: ["--gpu-intensity"],
	logFile: ["--log-file"],
	logFileMode: ["--log-file-mode"],
	minerPriority: ["--miner-priority"],
	retryTime: ["--retry-time"],
	proxy: ["--proxy"],
	tls: ["--tls"],
	esm: ["--esm"],
};

const BOOL_FLAGS = {
	apiEnable: ["--api-enable"],
	disableCpu: ["--disable-cpu"],
	disableGpu: ["--disable-gpu"],
	disableGpuAmd: ["--disable-gpu-amd"],
	disableGpuNvidia: ["--disable-gpu-nvidia"],
	disableGpuIntel: ["--disable-gpu-intel"],
	enableIgpu: ["--enable-igpu"],
	extendedLog: ["--extended-log"],
	listDevices: ["--list-devices", "-l", "--device-list"],
	listAlgorithms: ["--list-algorithms"],
	help: ["-h", "--help"],
};

const FLAG_INDEX = Object.create(null);
for (const [key, names] of Object.entries(VALUE_FLAGS)) {
	for (const name of names) FLAG_INDEX[name] = { key, kind: "value" };
}
for (const [key, names] of Object.entries(BOOL_FLAGS)) {
	for (const name of names) FLAG_INDEX[name] = { key, kind: "bool" };
}

function parseMinerArgs(args) {
	const out = Object.create(null);
	const len = args.length;
	for (let i = 0; i < len; i++) {
		const token = args[i];
		let name = token;
		let inline = null;
		const eq = token.indexOf("=");
		if (eq > 1 && token.charCodeAt(0) === 45) {
			name = token.slice(0, eq);
			inline = token.slice(eq + 1);
		}
		if (name === "-w" || name === "--worker") {
			if (inline === null && i + 1 < len && !args[i + 1].startsWith("-")) i++;
			continue;
		}
		const spec = FLAG_INDEX[name];
		if (!spec) continue;
		if (spec.kind === "bool") {
			out[spec.key] = true;
			continue;
		}
		if (inline !== null) {
			out[spec.key] = inline;
			continue;
		}
		if (i + 1 < len) {
			out[spec.key] = args[++i];
		}
	}
	return out;
}

module.exports = { parseMinerArgs };

