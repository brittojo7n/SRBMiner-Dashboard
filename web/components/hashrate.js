import { make, text } from "../lib/dom.js";
import { DASH } from "../lib/present.js";

export function createHashrateMetric(opts = {}) {
	const { label = "Total Hashrate", surface = 1 } = opts;

	const node = make("div", "metric metric-hashrate");
	node.classList.add(surface === 1 ? "metric--card" : "metric--tile");
	node.style.flexDirection = "column";

	const labelEl = make("div", "metric-label", label);
	const contentBox = make("div", "hashrate-content");
	contentBox.style.display = "flex";
	contentBox.style.flexDirection = "column";
	contentBox.style.gap = "8px";
	contentBox.style.width = "100%";
	
	node.append(labelEl, contentBox);

	function parseHr(hrStr) {
		if (!hrStr || hrStr === DASH) return { num: DASH, unit: "" };
		const parts = hrStr.trim().split(/\s+/);
		if (parts.length >= 2) {
			return { num: parts[0], unit: parts.slice(1).join(" ") };
		}
		return { num: hrStr, unit: "" };
	}

	function createRow(algoName, leftTag, leftVal, rightTag, rightVal) {
		const row = make("div", "hashrate-algo-row");
		row.style.display = "flex";
		row.style.flexDirection = "column";
		row.style.gap = "4px";

		if (algoName) {
			const aName = make("div", "metric-device-tag", algoName);
			aName.style.alignSelf = "flex-start";
			row.append(aName);
		}

		const dualBox = make("div", "hashrate-dual");
		dualBox.style.display = "flex";

		const lSlot = make("div", "hashrate-slot");
		const lTag = make("span", "slot-tag", leftTag);
		const lValEl = make("div", "slot-val accent-cyan");
		const lNum = make("span", "metric-num", leftVal.num);
		const lUnit = make("span", "metric-unit", leftVal.unit);
		lValEl.append(lNum, lUnit);
		
		if (leftTag) lSlot.append(lTag);
		lSlot.append(lValEl);
		dualBox.append(lSlot);

		if (rightTag && rightVal) {
			const divider = make("div", "hashrate-divider");
			const rSlot = make("div", "hashrate-slot");
			const rTag = make("span", "slot-tag", rightTag);
			const rValEl = make("div", "slot-val accent-cyan");
			const rNum = make("span", "metric-num", rightVal.num);
			const rUnit = make("span", "metric-unit", rightVal.unit);
			rValEl.append(rNum, rUnit);
			rSlot.append(rTag, rValEl);
			dualBox.append(divider, rSlot);
		}

		row.append(dualBox);
		return row;
	}

	return {
		node,
		set(data = {}) {
			const { hasCpuMining, hasGpuMining, hashrateCpu, hashrateGpu, hashrate, algoHashrates } = data;
			contentBox.innerHTML = "";

			if (algoHashrates && algoHashrates.length > 0) {
				algoHashrates.forEach(a => {
					let row;
					if (a.hasCpu && a.hasGpu) {
						row = createRow(a.name, "GPU", parseHr(a.gpu), "CPU", parseHr(a.cpu));
					} else if (a.hasGpu) {
						row = createRow(a.name, "GPU", parseHr(a.gpu));
					} else if (a.hasCpu) {
						row = createRow(a.name, "CPU", parseHr(a.cpu));
					} else {
						row = createRow(a.name, "", parseHr(a.total));
					}
					contentBox.append(row);
				});
			} else {
				let row;
				if (hasCpuMining && hasGpuMining) {
					row = createRow("", "GPU", parseHr(hashrateGpu), "CPU", parseHr(hashrateCpu));
				} else if (hasGpuMining) {
					row = createRow("", "GPU", parseHr(hashrateGpu || hashrate));
				} else if (hasCpuMining) {
					row = createRow("", "CPU", parseHr(hashrateCpu || hashrate));
				} else {
					row = createRow("", "", parseHr(hashrate));
				}
				contentBox.append(row);
			}

			return this;
		},
	};
}
