import { make, text } from "../lib/dom.js";
import { createMetric } from "./metric.js";
import { formatHashrate } from "../lib/present.js";

const DEFAULT_SPEC = Object.freeze({
	metrics: Object.freeze([
		{ key: "power", label: "Package Power", unit: "W" },
		{ key: "hashrate", label: "Total Hashrate", accent: "cyan" },
	]),
});

let cards = [];

function buildCard(spec = DEFAULT_SPEC) {
	const panel = make("div", "gpu-panel");
	const head = make("div", "gpu-head");
	const name = make("div", "gpu-name");
	const subtitle = make("div", "small");
	head.append(name, subtitle);

	const metrics = make("div", "metrics mt-0");
	const refs = { name, subtitle };

	for (let i = 0; i < spec.metrics.length; i++) {
		const m = spec.metrics[i];
		const metric = createMetric({
			label: m.label,
			unit: m.unit || "",
			accent: m.accent || null,
			surface: 2,
		});
		metrics.appendChild(metric.node);
		refs[m.key] = metric;
	}

	const threadsHead = make("div", "small", "Active Worker Threads");
	threadsHead.style.marginTop = "12px";
	threadsHead.style.marginBottom = "6px";
	threadsHead.style.fontWeight = "600";
	const threadsContainer = make("div", "metrics mt-0");
	refs.threads = threadsContainer;
	refs.threadsHead = threadsHead;

	panel.append(head, metrics, threadsHead, threadsContainer);
	return { panel, refs };
}

export function render(container, cpus, spec = DEFAULT_SPEC) {
	const section = document.getElementById("cpuSection");
	if (!cpus || cpus.length === 0) {
		if (section) section.style.display = "none";
		container.textContent = "";
		return;
	}
	if (section) section.style.display = "block";

	if (cards.length !== cpus.length || !cards.length) {
		cards = cpus.map(() => buildCard(spec));
		container.textContent = "";
		const frag = document.createDocumentFragment();
		for (let i = 0; i < cards.length; i++) frag.appendChild(cards[i].panel);
		container.appendChild(frag);
	}

	for (let i = 0; i < cpus.length; i++) {
		const v = cpus[i];
		const r = cards[i].refs;
		text(r.name, v.name || `CPU ${v.id || i}`);

		const cacheInfo = [];
		if (v.l3) cacheInfo.push(`L3: ${Math.round(v.l3 / 1048576)} MB`);
		if (v.l2) cacheInfo.push(`L2: ${Math.round(v.l2 / 1048576)} MB`);
		if (v.l1) cacheInfo.push(`L1: ${Math.round(v.l1 / 1024)} KB`);
		text(r.subtitle, cacheInfo.length ? cacheInfo.join(" • ") : "Live Telemetry");

		r.power.set({ value: v.packagePowerW != null ? String(v.packagePowerW) : "0" });
		r.hashrate.set({ value: formatHashrate(v.hashrate) });

		const threadEntries = v.threads ? Object.entries(v.threads) : [];
		r.threadsHead.style.display = threadEntries.length ? "block" : "none";
		r.threadCards ||= [];
		if (r.threadCards.length !== threadEntries.length) {
			r.threads.textContent = "";
			r.threadCards = threadEntries.map(([t]) => {
				const m = createMetric({ label: t.toUpperCase(), surface: 2, small: true });
				r.threads.appendChild(m.node);
				return m;
			});
		}
		for (let j = 0; j < threadEntries.length; j++) {
			r.threadCards[j].set({ value: formatHashrate(threadEntries[j][1]) });
		}
	}
}

