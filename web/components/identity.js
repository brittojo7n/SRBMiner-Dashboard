import { make, text } from "../lib/dom.js";
import { DASH } from "../lib/present.js";
import { parseMinerWallet, cleanPoolAddress } from "../lib/user.js";

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
	const singleAlgo = field("Algo");
	const singlePool = field("Pool");
	const singleWallet = field("Wallet");
	const singleWalletCopy = attachCopy(singleWallet);

	singleAlgo.row.hidden = singlePool.row.hidden = singleWallet.row.hidden = true;
	node.append(singleAlgo.row, singlePool.row, singleWallet.row);

	const multiSlots = [];
	const poolSlots = [];

	function getMultiSlot(i) {
		if (!multiSlots[i]) {
			const num = i + 1;
			const aField = field(`Algo ${num}`);
			const pField = field(`Pool ${num}`);
			const wField = field(`Wallet ${num}`);
			const copy = attachCopy(wField);
			node.append(aField.row, pField.row, wField.row);
			multiSlots[i] = { aField, pField, wField, copy };
		}
		return multiSlots[i];
	}

	function getPoolSlot(i) {
		if (!poolSlots[i]) {
			const pField = field(`Pool ${i + 1}`);
			node.appendChild(pField.row);
			poolSlots[i] = pField;
		}
		return poolSlots[i];
	}

	return {
		node,
		set(next = {}) {
			const algos = Array.isArray(next.algorithms) ? next.algorithms : [];
			const isMultiAlgo = algos.length >= 2;
			const pools = Array.isArray(next.pools) && next.pools.length > 0 ? next.pools : (next.pool ? [next.pool] : []);

			if (isMultiAlgo) {
				singleAlgo.row.hidden = singlePool.row.hidden = singleWallet.row.hidden = true;
				for (let i = 0; i < poolSlots.length; i++) poolSlots[i].row.hidden = true;

				for (let i = 0; i < algos.length; i++) {
					const slot = getMultiSlot(i);
					const item = algos[i];
					const aName = item?.name || `Algo ${i + 1}`;
					const pAddr = cleanPoolAddress(item?.pool?.address || pools[i] || pools[0] || "");
					const wAddr = parseMinerWallet(item?.pool?.wallet || next.wallet || "");

					text(slot.aField.value, aName);
					slot.aField.value.title = aName;
					slot.aField.row.hidden = false;

					text(slot.pField.value, pAddr || DASH);
					slot.pField.value.title = pAddr || "";
					slot.pField.row.hidden = !pAddr;

					text(slot.wField.value, wAddr || DASH);
					slot.wField.value.title = wAddr || "";
					slot.wField.row.hidden = false;
					slot.copy.setAddress(wAddr);
				}

				for (let i = algos.length; i < multiSlots.length; i++) {
					multiSlots[i].aField.row.hidden = true;
					multiSlots[i].pField.row.hidden = true;
					multiSlots[i].wField.row.hidden = true;
				}
				return this;
			}

			for (let i = 0; i < multiSlots.length; i++) {
				multiSlots[i].aField.row.hidden = true;
				multiSlots[i].pField.row.hidden = true;
				multiSlots[i].wField.row.hidden = true;
			}

			singleAlgo.row.hidden = !next.algo;
			if (next.algo) {
				text(singleAlgo.value, next.algo);
				singleAlgo.value.title = next.algo;
			}

			if (pools.length > 1) {
				singlePool.row.hidden = true;
				for (let i = 0; i < pools.length; i++) {
					const pSlot = getPoolSlot(i);
					const pAddr = cleanPoolAddress(pools[i]);
					text(pSlot.value, pAddr);
					pSlot.value.title = pAddr;
					pSlot.row.hidden = false;
				}
				for (let i = pools.length; i < poolSlots.length; i++) {
					poolSlots[i].row.hidden = true;
				}
			} else {
				for (let i = 0; i < poolSlots.length; i++) poolSlots[i].row.hidden = true;
				const pAddr = cleanPoolAddress(pools[0] || next.pool || "");
				singlePool.row.hidden = !pAddr;
				if (pAddr) {
					text(singlePool.value, pAddr);
					singlePool.value.title = pAddr;
				}
			}

			const addr = parseMinerWallet(next.wallet || "");
			singleWallet.row.hidden = !addr;
			if (addr) {
				text(singleWallet.value, addr);
				singleWallet.value.title = addr;
				singleWalletCopy.setAddress(addr);
			}

			return this;
		},
	};
}
