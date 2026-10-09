import { make, text } from "../lib/dom.js";
import { DASH } from "../lib/present.js";

const ACCENT_CLASS = {
	cyan: "accent-cyan",
	green: "accent-green",
	red: "accent-red",
	amber: "accent-amber",
	violet: "accent-violet",
};

const STATUS_ACCENT = { ok: "green", warn: "amber", danger: "red" };

function applyAccent(el, status, defaultAccent = "cyan") {
	for (const k in ACCENT_CLASS) el.classList.remove(ACCENT_CLASS[k]);
	const key = (status && STATUS_ACCENT[status]) || defaultAccent;
	if (key && ACCENT_CLASS[key]) el.classList.add(ACCENT_CLASS[key]);
}

export function createLatencyMetric(opts = {}) {
	const { label = "Pool Latency", surface = 2 } = opts;

	const node = make("div", "metric metric-latency");
	node.classList.add(surface === 1 ? "metric--card" : "metric--tile");

	const labelEl = make("div", "metric-label", label);

	const singleBox = make("div", "metric-value accent-cyan");
	const singleNum = make("span", "metric-num", DASH);
	const singleUnit = make("span", "metric-unit", "");
	singleBox.append(singleNum, singleUnit);

	const multiBox = make("div", "latency-multi");
	multiBox.style.display = "none";

	const rowTop = make("div", "latency-row");

	const slot1 = make("div", "latency-slot");
	const tag1 = make("span", "latency-tag", "POOL 1");
	const val1 = make("div", "latency-val accent-cyan");
	const num1 = make("span", "metric-num", DASH);
	const unit1 = make("span", "metric-unit", "");
	val1.append(num1, unit1);
	slot1.append(tag1, val1);

	const vertDivider = make("div", "latency-divider-vert");

	const slot2 = make("div", "latency-slot");
	const tag2 = make("span", "latency-tag", "POOL 2");
	const val2 = make("div", "latency-val accent-cyan");
	const num2 = make("span", "metric-num", DASH);
	const unit2 = make("span", "metric-unit", "");
	val2.append(num2, unit2);
	slot2.append(tag2, val2);

	rowTop.append(slot1, vertDivider, slot2);

	const horizDivider = make("div", "latency-divider-horiz");
	const rowBottom = make("div", "latency-row latency-row-bottom");

	const slot3 = make("div", "latency-slot");
	const tag3 = make("span", "latency-tag", "POOL 3");
	const val3 = make("div", "latency-val accent-cyan");
	const num3 = make("span", "metric-num", DASH);
	const unit3 = make("span", "metric-unit", "");
	val3.append(num3, unit3);
	slot3.append(tag3, val3);

	const vertDivider2 = make("div", "latency-divider-vert");

	const slot4 = make("div", "latency-slot");
	const tag4 = make("span", "latency-tag", "POOL 4");
	const val4 = make("div", "latency-val accent-cyan");
	const num4 = make("span", "metric-num", DASH);
	const unit4 = make("span", "metric-unit", "");
	val4.append(num4, unit4);
	slot4.append(tag4, val4);

	vertDivider2.style.display = "none";
	slot4.style.display = "none";
	horizDivider.style.display = "none";
	rowBottom.style.display = "none";

	rowBottom.append(slot3, vertDivider2, slot4);
	multiBox.append(rowTop, horizDivider, rowBottom);
	node.append(labelEl, singleBox, multiBox);

	return {
		node,
		set(data = {}) {
			const pools = Array.isArray(data.pools) ? data.pools : [];

			if (pools.length > 1) {
				singleBox.style.display = "none";
				multiBox.style.display = "flex";

				rowTop.style.display = "flex";
				slot1.style.display = "flex";
				slot2.style.display = "flex";
				vertDivider.style.display = "block";

				const p0 = pools[0] || {};
				text(num1, p0.num || DASH);
				text(unit1, p0.unit ? " " + p0.unit : "");
				applyAccent(val1, p0.status, "cyan");

				const p1 = pools[1] || {};
				text(num2, p1.num || DASH);
				text(unit2, p1.unit ? " " + p1.unit : "");
				applyAccent(val2, p1.status, "cyan");

				if (pools.length >= 3) {
					horizDivider.style.display = "block";
					rowBottom.style.display = "flex";
					slot3.style.display = "flex";

					const p2 = pools[2] || {};
					text(num3, p2.num || DASH);
					text(unit3, p2.unit ? " " + p2.unit : "");
					applyAccent(val3, p2.status, "cyan");

					if (pools.length >= 4) {
						vertDivider2.style.display = "block";
						slot4.style.display = "flex";
						const p3 = pools[3] || {};
						text(num4, p3.num || DASH);
						text(unit4, p3.unit ? " " + p3.unit : "");
						applyAccent(val4, p3.status, "cyan");
					} else {
						vertDivider2.style.display = "none";
						slot4.style.display = "none";
					}
				} else {
					horizDivider.style.display = "none";
					rowBottom.style.display = "none";
				}
			} else {
				multiBox.style.display = "none";
				singleBox.style.display = "flex";

				const single = pools[0] || {};
				const valText = data.value !== undefined ? data.value : (single.text || DASH);
				const status = data.status !== undefined ? data.status : single.status;

				if (valText && valText.endsWith(" ms")) {
					text(singleNum, valText.slice(0, -3));
					text(singleUnit, " ms");
				} else {
					text(singleNum, valText);
					text(singleUnit, "");
				}
				applyAccent(singleBox, status, "cyan");
			}
			return this;
		},
	};
}
