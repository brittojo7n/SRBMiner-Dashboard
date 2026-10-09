const fs = require("node:fs");
const path = require("node:path");
const { resolveIdentity, cleanPoolAddress } = require("../../web/lib/user");
const { parseMinerArgs } = require("./args");

const GPU_POLL_MS = 5000;
const API_POLL_MS = 10000;
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

function parseEnvFile(text) {
  const out = Object.create(null);
  if (!text) return out;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.charCodeAt(0) === 35) continue;
    const match = /^\s*([\w.-]+)\s*=\s*(.*)?\s*$/.exec(line);
    if (!match) continue;
    let val = match[2] || "";
    const quote = val[0];
    if (quote === '"' || quote === "'") {
      const end = val.lastIndexOf(quote);
      val = end > 0 ? val.slice(1, end) : val.slice(1);
    } else {
      const comment = val.indexOf(" #");
      if (comment !== -1) val = val.slice(0, comment);
      val = val.trim();
    }
    out[match[1]] = val;
  }
  return out;
}

function loadEnvFile(envPath, env = process.env) {
  const target = envPath || env.ENV_FILE || path.join(path.resolve(__dirname, "..", ".."), ".env");
  try {
    if (!fs.existsSync(target)) return env;
    const parsed = parseEnvFile(fs.readFileSync(target, "utf8"));
    for (const key of Object.keys(parsed)) {
      if (env[key] === undefined) env[key] = parsed[key];
    }
  } catch (err) {
    console.warn(`[dashboard] warning: reading env file "${target}" failed:`, err.message);
  }
  return env;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function splitArgs(raw) {
  return (String(raw || "").match(/"([^"]*)"|(\S+)/g) || []).map((token) => token.replace(/^"|"$/g, ""));
}

function buildConfig(env = process.env, opts = {}) {
  const platform = opts.platform || process.platform;
  const warnings = [];
  const rawPort = env.PORT;
  const PORT = clampInt(rawPort, 0, 65535, 4067);
  if (rawPort != null && rawPort !== "" && Number(rawPort) !== PORT) warnings.push(`PORT "${rawPort}" is invalid; using ${PORT}.`);
  const HOST = env.HOST || "127.0.0.1";
  const dashboardRoot = path.resolve(__dirname, "..", "..");
  const MINER_CWD = env.MINER_CWD
    ? (path.isAbsolute(env.MINER_CWD) ? env.MINER_CWD : path.resolve(dashboardRoot, env.MINER_CWD))
    : "";
  const MINER_EXE = env.MINER_EXE || (platform === "win32" ? "SRBMiner-MULTI.exe" : "SRBMiner-MULTI");
  const MINER_ARGS = splitArgs(env.MINER_ARGS);
  const flags = parseMinerArgs(MINER_ARGS);
  const explicitWallet = env.WALLET ? String(env.WALLET).trim() : "";
  const explicitWorker = env.WORKER ? String(env.WORKER).trim() : "";
  if (!flags.wallet && explicitWallet) flags.wallet = explicitWallet;
  if (!flags.worker && explicitWorker) flags.worker = explicitWorker;
  const identity = resolveIdentity(flags);
  const ALGO = flags.algo || "";
  const POOL = cleanPoolAddress(flags.pool || "");

  if (!MINER_ARGS.includes("--api-enable")) {
    MINER_ARGS.push("--api-enable");
  }
  const apiPortIdx = MINER_ARGS.findIndex((a) => a === "--api-port" || a.startsWith("--api-port="));
  let API_PORT = 21550;
  if (apiPortIdx !== -1) {
    const val = MINER_ARGS[apiPortIdx].startsWith("--api-port=")
      ? MINER_ARGS[apiPortIdx].slice(11)
      : MINER_ARGS[apiPortIdx + 1];
    const parsedPort = Number.parseInt(val, 10);
    if (Number.isFinite(parsedPort) && parsedPort > 0 && parsedPort <= 65535) API_PORT = parsedPort;
  } else {
    MINER_ARGS.push("--api-port", String(API_PORT));
  }

  return Object.freeze({
    PORT, HOST, GPU_POLL_MS, API_POLL_MS, API_PORT,
    MINER_EXE, MINER_ARGS: Object.freeze(MINER_ARGS), MINER_CWD,
    PASSPHRASE: env.PASSPHRASE || "", SESSION_SECRET: env.SESSION_SECRET || "",
    USER: identity.user, WALLET: identity.wallet, WORKER: identity.worker,
    ALGO, POOL,
    FORWARD_CONSOLE: String(env.FORWARD_CONSOLE).toLowerCase() === "true",
    warnings: Object.freeze(warnings),
  });
}

function validateConfig(config) {
  const fatal = [];
  if (!config.SESSION_SECRET) fatal.push("Missing SESSION_SECRET in .env file. Provide a random cryptographic string (e.g. 64 hex characters) to secure session cookies.");
  if (!LOCAL_HOSTS.has(config.HOST) && !config.PASSPHRASE) fatal.push(`Insecure configuration: HOST is bound to a non-local interface (${config.HOST}) without a PASSPHRASE. Set PASSPHRASE to prevent unauthorised access to your miner.`);
  return fatal;
}

loadEnvFile();
const config = buildConfig(process.env);

module.exports = Object.assign({}, config, { validateConfig, buildConfig, loadEnvFile, parseEnvFile, GPU_POLL_MS, API_POLL_MS });
