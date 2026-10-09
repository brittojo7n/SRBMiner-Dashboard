function parseMinerUser(raw) {
  const source = raw == null ? "" : String(raw).trim();
  if (!source) return { wallet: "", worker: null };
  const dot = source.indexOf(".");
  const slash = source.indexOf("/");
  const sep = dot !== -1 ? dot : slash;
  if (sep === -1) return { wallet: source, worker: null };
  const wallet = source.slice(0, sep).trim();
  const worker = source.slice(sep + 1).trim();
  return { wallet, worker: worker || null };
}

function formatMinerUser({ wallet, worker }) {
  const w = wallet ? String(wallet).trim() : "";
  const wk = worker ? String(worker).trim() : "";
  return w ? (wk ? `${w}.${wk}` : w) : "";
}

function workerFromPass(pass) {
  const v = pass == null ? "" : String(pass).trim();
  if (!v || /^x$/i.test(v) || v.includes("=")) return null;
  return v;
}

function resolveIdentity(flags) {
  const userOrWallet = flags ? (flags.wallet || flags.user) : "";
  const parsed = parseMinerUser(userOrWallet);
  const worker = flags && flags.worker ? String(flags.worker).trim() : (parsed.worker || workerFromPass(flags && (flags.password || flags.pass)));
  return { wallet: parsed.wallet, worker, user: formatMinerUser({ wallet: parsed.wallet, worker }) };
}

function minerUserSource(miner = {}) {
  if (miner.user) return miner.user;
  if (miner.worker) return `${miner.wallet || ""}.${miner.worker}`;
  return miner.wallet || "";
}

function cleanPoolAddress(raw) {
  if (raw == null) return "";
  return String(raw).trim().replace(/^(?:stratum(?:\d+)?(?:\+[a-z0-9]+)?|ssl|tcp):\/\//i, "");
}

export { parseMinerUser, formatMinerUser, workerFromPass, resolveIdentity, minerUserSource, cleanPoolAddress };
