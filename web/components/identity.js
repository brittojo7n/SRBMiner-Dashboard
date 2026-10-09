import { make, text } from "../lib/dom.js";
import { DASH } from "../lib/present.js";
import { parseMinerUser, minerUserSource, cleanPoolAddress } from "../lib/user.js";

const COPY_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
const CHECK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg>';

function writeClipboard(value) {
	if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value);
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
	const btn = make("button", "identity-copy");
	btn.type = "button";
	btn.title = "Copy wallet address";
	btn.setAttribute("aria-label", "Copy wallet address");
	btn.innerHTML = COPY_SVG;
	targetField.row.appendChild(btn);
	let addr = "", t = 0;
	const mark = (on) => {
		btn.classList.toggle("copied", on);
		btn.innerHTML = on ? CHECK_SVG : COPY_SVG;
		btn.title = on ? "Copied" : "Copy wallet address";
	};
	btn.addEventListener("click", async () => {
		if (!addr) return;
		try {
			await writeClipboard(addr);
			mark(true);
			clearTimeout(t);
			t = setTimeout(() => mark(false), 1600);
		} catch { mark(false); }
	});
	return {
		setAddress(a) {
			addr = a || "";
			btn.disabled = !addr;
		},
	};
}

export function createIdentity() {
	const node = make("div", "identity");
	const algo = field("Algo");
	const pool = field("Pool");
	const wallet = field("Wallet");
	const walletCopy = attachCopy(wallet);
	const worker = field("Worker");
	const dAlgo1 = field("Algo 1");
	const dWallet1 = field("Wallet 1");
	const dCopy1 = attachCopy(dWallet1);
	const dAlgo2 = field("Algo 2");
	const dWallet2 = field("Wallet 2");
	const dCopy2 = attachCopy(dWallet2);

	algo.row.hidden = pool.row.hidden = worker.row.hidden = true;
	dAlgo1.row.hidden = dWallet1.row.hidden = dAlgo2.row.hidden = dWallet2.row.hidden = true;
	node.append(algo.row, pool.row, wallet.row, worker.row, dAlgo1.row, dWallet1.row, dAlgo2.row, dWallet2.row);

	let lastKey = "";

	const setItem = (fAlgo, fWall, copy, item, fb) => {
		const w = item?.pool?.wallet ? parseMinerUser(item.pool.wallet).wallet || item.pool.wallet : "";
		const name = item?.name || fb;
		text(fAlgo.value, name); fAlgo.value.title = name;
		text(fWall.value, w || DASH); fWall.value.title = w;
		copy.setAddress(w);
	};

	return {
		node,
		set(next = {}) {
			const algos = Array.isArray(next.algorithms) ? next.algorithms : [];
			const isDual = algos.length >= 2;

			if (isDual) {
				algo.row.hidden = wallet.row.hidden = true;
				dAlgo1.row.hidden = dWallet1.row.hidden = dAlgo2.row.hidden = dWallet2.row.hidden = false;
				setItem(dAlgo1, dWallet1, dCopy1, algos[0], "Algo 1");
				setItem(dAlgo2, dWallet2, dCopy2, algos[1], "Algo 2");
			} else {
				dAlgo1.row.hidden = dWallet1.row.hidden = dAlgo2.row.hidden = dWallet2.row.hidden = true;
				algo.row.hidden = !next.algo;
				if (next.algo) { text(algo.value, next.algo); algo.value.title = next.algo; }
			}

			const clPool = cleanPoolAddress(next.pool);
			pool.row.hidden = !clPool;
			if (clPool) { text(pool.value, clPool); pool.value.title = clPool; }

			if (isDual) {
				const wk = next.worker || (algos[0]?.pool && parseMinerUser(algos[0].pool.wallet).worker) || (algos[1]?.pool && parseMinerUser(algos[1].pool.wallet).worker);
				worker.row.hidden = !wk;
				worker.row.classList.toggle("is-empty", !wk);
				text(worker.value, wk || ""); worker.value.title = wk || "";
				return this;
			}

			const rawUser = typeof next === "string" ? next : (next.user || minerUserSource(next));
			const parsed = parseMinerUser(rawUser);
			if (typeof next === "object" && next !== null) {
				if (!parsed.worker && next.worker) parsed.worker = String(next.worker).trim();
				if (!parsed.wallet && next.wallet) parsed.wallet = String(next.wallet).trim();
			}

			const nextKey = `${parsed.wallet}\0${parsed.worker || ""}\0${next.algo || ""}\0${clPool}`;
			if (nextKey === lastKey) return this;
			lastKey = nextKey;

			const addr = parsed.wallet || "";
			text(wallet.value, addr || DASH);
			wallet.value.title = addr;
			wallet.row.hidden = false;
			walletCopy.setAddress(addr);

			const hasWk = Boolean(parsed.worker);
			text(worker.value, hasWk ? parsed.worker : "");
			worker.value.title = hasWk ? parsed.worker : "";
			worker.row.hidden = !hasWk;
			worker.row.classList.toggle("is-empty", !hasWk);
			return this;
		},
	};
}
