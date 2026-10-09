import { make, text } from "../lib/dom.js";
import { DASH } from "../lib/present.js";
import { parseMinerUser, minerUserSource, cleanPoolAddress } from "../lib/user.js";

const COPY_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
const CHECK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg>';

function writeClipboard(value) {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
    return navigator.clipboard.writeText(value);
  }
  return new Promise((resolve, reject) => {
    const area = document.createElement("textarea");
    area.value = value;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.left = "-9999px";
    document.body.appendChild(area);
    area.select();
    try {
      if (!document.execCommand("copy")) throw new Error("copy");
      resolve();
    } catch (err) {
      reject(err);
    } finally {
      area.remove();
    }
  });
}

function field(labelText) {
  const row = make("div", "identity-field");
  const label = make("span", "identity-label", labelText);
  const value = make("span", "identity-value");
  row.append(label, value);
  return { row, value };
}

function attachCopy(targetField) {
  const copyBtn = make("button", "identity-copy");
  copyBtn.type = "button";
  copyBtn.title = "Copy wallet address";
  copyBtn.setAttribute("aria-label", "Copy wallet address");
  copyBtn.innerHTML = COPY_SVG;
  targetField.row.appendChild(copyBtn);

  let targetAddress = "";
  let timer = 0;

  function mark(on) {
    copyBtn.classList.toggle("copied", on);
    copyBtn.innerHTML = on ? CHECK_SVG : COPY_SVG;
    copyBtn.title = on ? "Copied" : "Copy wallet address";
  }

  copyBtn.addEventListener("click", async () => {
    if (!targetAddress) return;
    try {
      await writeClipboard(targetAddress);
      mark(true);
      clearTimeout(timer);
      timer = setTimeout(() => mark(false), 1600);
    } catch {
      mark(false);
    }
  });

  return {
    setAddress(addr) {
      targetAddress = addr || "";
      copyBtn.disabled = !targetAddress;
    },
  };
}

export function createIdentity() {
  const node = make("div", "identity");

  // Single-algo fields
  const algo = field("Algo");
  algo.row.hidden = true;
  const pool = field("Pool");
  pool.row.hidden = true;
  const wallet = field("Wallet");
  const walletCopy = attachCopy(wallet);
  const worker = field("Worker");
  worker.row.hidden = true;

  // Dual-mining dedicated rows (Algo 1 & Algo 2)
  const dualAlgo1 = field("Algo 1");
  const dualWallet1 = field("Wallet 1");
  const dualCopy1 = attachCopy(dualWallet1);

  const dualAlgo2 = field("Algo 2");
  const dualWallet2 = field("Wallet 2");
  const dualCopy2 = attachCopy(dualWallet2);

  dualAlgo1.row.hidden = true;
  dualWallet1.row.hidden = true;
  dualAlgo2.row.hidden = true;
  dualWallet2.row.hidden = true;

  node.append(
    algo.row,
    pool.row,
    wallet.row,
    worker.row,
    dualAlgo1.row,
    dualWallet1.row,
    dualAlgo2.row,
    dualWallet2.row
  );

  let lastKey = "";

  return {
    node,
    set(next = {}) {
      const algos = Array.isArray(next.algorithms) ? next.algorithms : [];
      const isDual = algos.length >= 2;

      if (isDual) {
        // Hide single-algo layout
        algo.row.hidden = true;
        wallet.row.hidden = true;

        // Show dual-algo layout in order: Algo 1, Wallet 1, Algo 2, Wallet 2
        dualAlgo1.row.hidden = false;
        dualWallet1.row.hidden = false;
        dualAlgo2.row.hidden = false;
        dualWallet2.row.hidden = false;

        const a1 = algos[0];
        const a2 = algos[1];

        const w1 = a1.pool && a1.pool.wallet ? parseMinerUser(a1.pool.wallet).wallet || a1.pool.wallet : "";
        const w2 = a2.pool && a2.pool.wallet ? parseMinerUser(a2.pool.wallet).wallet || a2.pool.wallet : "";

        text(dualAlgo1.value, a1.name || "Algo 1");
        dualAlgo1.value.title = a1.name || "";

        text(dualWallet1.value, w1 || DASH);
        dualWallet1.value.title = w1;
        dualCopy1.setAddress(w1);

        text(dualAlgo2.value, a2.name || "Algo 2");
        dualAlgo2.value.title = a2.name || "";

        text(dualWallet2.value, w2 || DASH);
        dualWallet2.value.title = w2;
        dualCopy2.setAddress(w2);

        // Optional worker / pool display if available
        const cleanedPool = cleanPoolAddress(next.pool);
        if (cleanedPool) {
          text(pool.value, cleanedPool);
          pool.value.title = cleanedPool;
          pool.row.hidden = false;
        } else {
          pool.row.hidden = true;
        }

        const workerName = next.worker || (a1.pool && parseMinerUser(a1.pool.wallet).worker) || (a2.pool && parseMinerUser(a2.pool.wallet).worker);
        const hasWorker = Boolean(workerName);
        text(worker.value, hasWorker ? workerName : "");
        worker.value.title = hasWorker ? workerName : "";
        worker.row.hidden = !hasWorker;
        worker.row.classList.toggle("is-empty", !hasWorker);
        return this;
      }

      // Single-algo layout
      dualAlgo1.row.hidden = true;
      dualWallet1.row.hidden = true;
      dualAlgo2.row.hidden = true;
      dualWallet2.row.hidden = true;

      if (next.algo) {
        text(algo.value, next.algo);
        algo.value.title = next.algo;
        algo.row.hidden = false;
      } else {
        algo.row.hidden = true;
      }

      const cleanedPool = cleanPoolAddress(next.pool);
      if (cleanedPool) {
        text(pool.value, cleanedPool);
        pool.value.title = cleanedPool;
        pool.row.hidden = false;
      } else {
        pool.row.hidden = true;
      }

      const rawUser = typeof next === "string" ? next : (next.user || minerUserSource(next));
      const parsed = parseMinerUser(rawUser);
      if (typeof next === "object" && next !== null) {
        if (!parsed.worker && next.worker) parsed.worker = String(next.worker).trim();
        if (!parsed.wallet && next.wallet) parsed.wallet = String(next.wallet).trim();
      }

      const nextKey = `${parsed.wallet}\0${parsed.worker || ""}\0${next.algo || ""}\0${cleanedPool}`;
      if (nextKey === lastKey) return this;
      lastKey = nextKey;

      const address = parsed.wallet || "";
      text(wallet.value, address || DASH);
      wallet.value.title = address;
      wallet.row.hidden = false;
      walletCopy.setAddress(address);

      const hasWorker = Boolean(parsed.worker);
      text(worker.value, hasWorker ? parsed.worker : "");
      worker.value.title = hasWorker ? parsed.worker : "";
      worker.row.hidden = !hasWorker;
      worker.row.classList.toggle("is-empty", !hasWorker);
      return this;
    },
  };
}
