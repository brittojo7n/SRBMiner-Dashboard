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
  
  for (const m of spec.metrics) {
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
    for (const card of cards) frag.appendChild(card.panel);
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
    
    r.threads.textContent = "";
    const threadEntries = v.threads ? Object.entries(v.threads) : [];
    r.threadsHead.style.display = threadEntries.length ? "block" : "none";
    if (threadEntries.length) {
      for (const [threadId, hr] of threadEntries) {
        const metric = createMetric({
          label: threadId.toUpperCase(),
          value: formatHashrate(hr),
          surface: 2,
          small: true,
        });
        r.threads.appendChild(metric.node);
      }
    }
  }
}

