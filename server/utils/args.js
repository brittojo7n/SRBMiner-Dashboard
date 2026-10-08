const VALUE_FLAGS = Object.freeze({
  algo: Object.freeze(["-a", "--algorithm"]),
  algoCpu: Object.freeze(["-ac", "--algorithm-cpu"]),
  algoGpu: Object.freeze(["-ag", "--algorithm-gpu"]),
  pool: Object.freeze(["-o", "--pool", "--server", "--url"]),
  wallet: Object.freeze(["-u", "--wallet", "--user"]),
  worker: Object.freeze(["-w", "--worker"]),
  password: Object.freeze(["-p", "--password", "--pass"]),
  cpuThreads: Object.freeze(["-t", "--cpu-threads"]),
  cpuThreadsPriority: Object.freeze(["--cpu-threads-priority"]),
  cpuThreadsIntensity: Object.freeze(["--cpu-threads-intensity"]),
  cpuAffinity: Object.freeze(["--cpu-affinity"]),
  apiPort: Object.freeze(["--api-port"]),
  apiRigName: Object.freeze(["--api-rig-name"]),
  gpuId: Object.freeze(["--gpu-id"]),
  gpuIntensity: Object.freeze(["--gpu-intensity"]),
  logFile: Object.freeze(["--log-file"]),
  logFileMode: Object.freeze(["--log-file-mode"]),
  minerPriority: Object.freeze(["--miner-priority"]),
  retryTime: Object.freeze(["--retry-time"]),
  proxy: Object.freeze(["--proxy"]),
  tls: Object.freeze(["--tls"]),
  esm: Object.freeze(["--esm"]),
});

const BOOL_FLAGS = Object.freeze({
  apiEnable: Object.freeze(["--api-enable"]),
  disableCpu: Object.freeze(["--disable-cpu"]),
  disableGpu: Object.freeze(["--disable-gpu"]),
  disableGpuAmd: Object.freeze(["--disable-gpu-amd"]),
  disableGpuNvidia: Object.freeze(["--disable-gpu-nvidia"]),
  disableGpuIntel: Object.freeze(["--disable-gpu-intel"]),
  enableIgpu: Object.freeze(["--enable-igpu"]),
  extendedLog: Object.freeze(["--extended-log"]),
  listDevices: Object.freeze(["--list-devices", "-l", "--device-list"]),
  listAlgorithms: Object.freeze(["--list-algorithms"]),
  help: Object.freeze(["-h", "--help"]),
});

function flagIndex() {
  const map = Object.create(null);
  for (const [key, names] of Object.entries(VALUE_FLAGS)) {
    for (const name of names) map[name] = { key, kind: "value" };
  }
  for (const [key, names] of Object.entries(BOOL_FLAGS)) {
    for (const name of names) map[name] = { key, kind: "bool" };
  }
  return map;
}

const FLAG_INDEX = flagIndex();

function parseMinerArgs(args) {
  const out = Object.create(null);
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    let name = token;
    let inline = null;
    const eq = token.indexOf("=");
    if (eq > 1 && token.startsWith("-")) {
      name = token.slice(0, eq);
      inline = token.slice(eq + 1);
    }
    const spec = FLAG_INDEX[name];
    if (!spec) continue;
    if (spec.kind === "bool") {
      out[spec.key] = true;
      continue;
    }
    if (inline != null) {
      out[spec.key] = inline;
      continue;
    }
    if (i + 1 < args.length) {
      out[spec.key] = args[++i];
    }
  }
  return out;
}

module.exports = { parseMinerArgs };

