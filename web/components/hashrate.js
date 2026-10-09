import { make, text } from "../lib/dom.js";
import { DASH } from "../lib/present.js";

export function createHashrateMetric(opts = {}) {
	const { label = "Total Hashrate", surface = 1 } = opts;

	const node = make("div", "metric metric-hashrate");
	node.classList.add(surface === 1 ? "metric--card" : "metric--tile");

	const labelEl = make("div", "metric-label", label);
	const indicatorEl = make("div", "metric-device-tag", "");
	indicatorEl.style.display = "none";

	const singleBox = make("div", "metric-value accent-cyan");
	const singleNum = make("span", "metric-num", DASH);
	const singleUnit = make("span", "metric-unit", "");
	singleBox.append(singleNum, singleUnit);

	const dualBox = make("div", "hashrate-dual");
	dualBox.style.display = "none";

	const gpuSlot = make("div", "hashrate-slot");
	const gpuTag = make("span", "slot-tag", "GPU");
	const gpuVal = make("div", "slot-val accent-cyan");
	const gpuNum = make("span", "metric-num", DASH);
	const gpuUnit = make("span", "metric-unit", "");
	gpuVal.append(gpuNum, gpuUnit);
	gpuSlot.append(gpuTag, gpuVal);

	const divider = make("div", "hashrate-divider");

	const cpuSlot = make("div", "hashrate-slot");
	const cpuTag = make("span", "slot-tag", "CPU");
	const cpuVal = make("div", "slot-val accent-cyan");
	const cpuNum = make("span", "metric-num", DASH);
	const cpuUnit = make("span", "metric-unit", "");
	cpuVal.append(cpuNum, cpuUnit);
	cpuSlot.append(cpuTag, cpuVal);

	dualBox.append(gpuSlot, divider, cpuSlot);

	node.append(labelEl, indicatorEl, singleBox, dualBox);

	function parseHr(hrStr) {
		if (!hrStr || hrStr === DASH) return { num: DASH, unit: "" };
		const parts = hrStr.trim().split(/\s+/);
		if (parts.length >= 2) {
			return { num: parts[0], unit: parts.slice(1).join(" ") };
		}
		return { num: hrStr, unit: "" };
	}

	return {
		node,
		set(data = {}) {
			const { hasCpuMining, hasGpuMining, hashrateCpu, hashrateGpu, hashrate } = data;

			if (hasCpuMining && hasGpuMining) {
				singleBox.style.display = "none";
				dualBox.style.display = "flex";
				indicatorEl.style.display = "none";

				const g = parseHr(hashrateGpu);
				text(gpuNum, g.num);
				text(gpuUnit, g.unit);

				const c = parseHr(hashrateCpu);
				text(cpuNum, c.num);
				text(cpuUnit, c.unit);
			} else {
				dualBox.style.display = "none";
				singleBox.style.display = "flex";

				let targetHr = hashrate;
				let tagText = "";

				if (hasGpuMining) {
					tagText = "GPU";
					targetHr = hashrateGpu || hashrate;
				} else if (hasCpuMining) {
					tagText = "CPU";
					targetHr = hashrateCpu || hashrate;
				}

				if (tagText) {
					text(indicatorEl, tagText);
					indicatorEl.style.display = "";
				} else {
					indicatorEl.style.display = "none";
				}

				const s = parseHr(targetHr);
				text(singleNum, s.num);
				text(singleUnit, s.unit);
			}
			return this;
		},
	};
}
