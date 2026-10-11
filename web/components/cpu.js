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
	const info = make("div", "gpu-head-info");
	const name = make("div", "gpu-name");
	const subtitle = make("div", "gpu-subtext");
	info.append(name, subtitle);
	head.append(info);

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

	const threadsHead = make("div", "gpu-head");
	threadsHead.style.marginTop = "12px";
	threadsHead.style.marginBottom = "6px";
	threadsHead.style.padding = "0";
	threadsHead.style.border = "none";

	const titleText = make("div", "small", "Active Worker Threads");
	titleText.style.fontWeight = "600";
	
	const paginator = make("div", "thread-paginator");
	paginator.style.display = "flex";
	paginator.style.gap = "8px";
	paginator.style.alignItems = "center";
	paginator.style.fontWeight = "normal";
	paginator.style.fontSize = "12px";

	const btnPrev = make("button", "c-btn", "<");
	btnPrev.style.padding = "2px 8px";
	btnPrev.style.minHeight = "24px";
	const pageText = make("span", null, "1 / 1");
	const btnNext = make("button", "c-btn", ">");
	btnNext.style.padding = "2px 8px";
	btnNext.style.minHeight = "24px";

	paginator.append(btnPrev, pageText, btnNext);
	threadsHead.append(titleText, paginator);

	const threadsContainer = make("div", "metrics mt-0");
	refs.threads = threadsContainer;
	refs.threadsHead = threadsHead;
	refs.paginator = paginator;
	refs.pageText = pageText;
	refs.btnPrev = btnPrev;
	refs.btnNext = btnNext;
	refs.currentPage = 0;

	panel.append(head, metrics, threadsHead, threadsContainer);
	return { panel, refs };
}

export function render(container, cpus, opts = {}) {
	const spec = { ...DEFAULT_SPEC, ...opts };
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

		r.subtitle.textContent = "";
		const algoName = (v.algos && v.algos.length) ? v.algos.join(" + ") : (spec.defaultAlgo || "");
		if (algoName) {
			const tag = make("span", "cpu-algo-tag", algoName);
			r.subtitle.appendChild(tag);
		}

		const cacheInfo = [];
		if (v.l3) cacheInfo.push(`L3: ${Math.round(v.l3 / 1048576)} MB`);
		if (v.l2) cacheInfo.push(`L2: ${Math.round(v.l2 / 1048576)} MB`);
		if (v.l1) cacheInfo.push(`L1: ${Math.round(v.l1 / 1024)} KB`);

		if (cacheInfo.length) {
			if (algoName) {
				const sep = make("span", "subtext-sep", " • ");
				r.subtitle.appendChild(sep);
			}
			const cacheEl = make("span", "cpu-cache-text", cacheInfo.join(" • "));
			r.subtitle.appendChild(cacheEl);
		} else if (!algoName) {
			text(r.subtitle, "Live Telemetry");
		}

		r.power.set({ value: v.packagePowerW != null ? String(Math.round(v.packagePowerW)) : "0" });
		r.hashrate.set({ value: formatHashrate(v.hashrate) });

		const threadEntries = v.threads ? Object.entries(v.threads) : [];
		r.threadsHead.style.display = threadEntries.length ? "flex" : "none";
		
		const PAGE_SIZE = 8;
		const totalPages = Math.ceil(threadEntries.length / PAGE_SIZE);
		if (r.currentPage >= totalPages) r.currentPage = Math.max(0, totalPages - 1);

		if (totalPages > 1) {
			r.paginator.style.display = "flex";
			text(r.pageText, `${r.currentPage + 1} / ${totalPages}`);
			r.btnPrev.onclick = () => { r.currentPage = Math.max(0, r.currentPage - 1); render(container, cpus, spec); };
			r.btnNext.onclick = () => { r.currentPage = Math.min(totalPages - 1, r.currentPage + 1); render(container, cpus, spec); };
			r.btnPrev.disabled = r.currentPage === 0;
			r.btnNext.disabled = r.currentPage === totalPages - 1;
		} else {
			r.paginator.style.display = "none";
		}

		const visibleEntries = threadEntries.slice(r.currentPage * PAGE_SIZE, (r.currentPage + 1) * PAGE_SIZE);

		r.threadCards ||= [];
		if (r.threadCards.length !== visibleEntries.length) {
			r.threads.textContent = "";
			r.threadCards = visibleEntries.map(() => {
				const m = createMetric({ label: "", surface: 2, small: true });
				r.threads.appendChild(m.node);
				return m;
			});
		}
		for (let j = 0; j < visibleEntries.length; j++) {
			const labelNode = r.threadCards[j].node.querySelector('.metric-label');
			if (labelNode) text(labelNode, visibleEntries[j][0].toUpperCase());
			r.threadCards[j].set({ value: formatHashrate(visibleEntries[j][1]) });
		}
	}
}

