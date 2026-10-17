import { make } from "../lib/dom.js";

export function createRestartTooltip(parentCard) {
	const wrap = make("span", "tooltip-anchor");
	const btn = make("button", "tooltip-trigger");
	btn.type = "button";
	btn.setAttribute("aria-label", "Auto restart details");
	btn.setAttribute("aria-expanded", "false");

	const svgNs = "http://www.w3.org/2000/svg";
	const svg = document.createElementNS(svgNs, "svg");
	svg.setAttribute("viewBox", "0 0 24 24");
	svg.setAttribute("fill", "none");
	svg.setAttribute("stroke", "currentColor");
	svg.setAttribute("stroke-width", "2.4");
	svg.setAttribute("stroke-linecap", "round");
	svg.setAttribute("stroke-linejoin", "round");
	svg.setAttribute("class", "tooltip-icon");
	svg.setAttribute("aria-hidden", "true");

	const circle = document.createElementNS(svgNs, "circle");
	circle.setAttribute("cx", "12");
	circle.setAttribute("cy", "12");
	circle.setAttribute("r", "10");

	const line1 = document.createElementNS(svgNs, "line");
	line1.setAttribute("x1", "12");
	line1.setAttribute("y1", "16");
	line1.setAttribute("x2", "12");
	line1.setAttribute("y2", "12");

	const line2 = document.createElementNS(svgNs, "line");
	line2.setAttribute("x1", "12");
	line2.setAttribute("y1", "8");
	line2.setAttribute("x2", "12.01");
	line2.setAttribute("y2", "8");

	svg.append(circle, line1, line2);
	btn.appendChild(svg);

	const popup = make("div", "tooltip-popup");
	popup.setAttribute("role", "tooltip");

	const header = make("div", "tooltip-header");
	const titleWrap = make("div", "tooltip-title-wrap");
	const dot = make("span", "tooltip-dot");
	const title = make("span", "tooltip-title", "Auto Restart Modes");
	titleWrap.append(dot, title);

	const closeBtn = make("button", "tooltip-close", "\u00d7");
	closeBtn.type = "button";
	closeBtn.setAttribute("aria-label", "Close tooltip");
	header.append(titleWrap, closeBtn);

	const list = make("div", "tooltip-list");

	const itemR = make("div", "tooltip-item");
	const rowR = make("div", "tooltip-item-row");
	const badgeR = make("span", "tooltip-badge badge-r", "R");
	const nameR = make("span", "tooltip-name", "Normal Restart");
	rowR.append(badgeR, nameR);
	const descR = make("div", "tooltip-desc", "Miner had a minor issue (e.g. driver glitch) and safely restarted itself within 60s.");
	itemR.append(rowR, descR);

	const itemHr = make("div", "tooltip-item");
	const rowHr = make("div", "tooltip-item-row");
	const badgeHr = make("span", "tooltip-badge badge-hr", "HR");
	const nameHr = make("span", "tooltip-name", "Hard Restart");
	rowHr.append(badgeHr, nameHr);
	const descHr = make("div", "tooltip-desc", "Miner froze or failed to recover within 60s. The dashboard watchdog forced a fresh start.");
	itemHr.append(rowHr, descHr);

	list.append(itemR, itemHr);

	const note = make("div", "tooltip-note", "Mining uptime resets only upon a manual stop or restart.");

	popup.append(header, list, note);
	wrap.append(btn, popup);

	let open = false;
	let hoverTimeout;
	let closeTimeout;

	const adjustPos = () => {
		popup.style.removeProperty("--tt-left");
		popup.style.removeProperty("--tt-arrow");
		const wrapRect = wrap.getBoundingClientRect();
		const popupRect = popup.getBoundingClientRect();
		const pad = 12;
		const viewportW = window.innerWidth;
		const defaultLeft = -12;
		let currentLeft = defaultLeft;
		const rightEdge = wrapRect.left + defaultLeft + popupRect.width;
		if (rightEdge > viewportW - pad) {
			currentLeft -= (rightEdge - (viewportW - pad));
		}
		if (wrapRect.left + currentLeft < pad) {
			currentLeft = pad - wrapRect.left;
		}
		popup.style.setProperty("--tt-left", `${currentLeft}px`);
		const triggerCenterInPopup = (wrapRect.width / 2) - currentLeft;
		const arrowLeft = Math.max(14, Math.min(triggerCenterInPopup - 5, popupRect.width - 24));
		popup.style.setProperty("--tt-arrow", `${arrowLeft}px`);
	};

	const setOpen = (val) => {
		open = Boolean(val);
		btn.setAttribute("aria-expanded", String(open));
		popup.classList.toggle("show", open);
		
		clearTimeout(closeTimeout);
		if (parentCard) {
			if (open) {
				parentCard.style.zIndex = "40";
			} else {
				closeTimeout = setTimeout(() => {
					if (!open) parentCard.style.zIndex = "";
				}, 180);
			}
		}
		
		if (open) {
			adjustPos();
		} else {
			btn.blur();
		}
	};

	const triggerOpen = () => {
		clearTimeout(hoverTimeout);
		if (!open) {
			hoverTimeout = setTimeout(() => setOpen(true), 300);
		}
	};

	const triggerClose = () => {
		clearTimeout(hoverTimeout);
		if (open) {
			hoverTimeout = setTimeout(() => setOpen(false), 300);
		}
	};

	btn.addEventListener("click", (e) => {
		e.stopPropagation();
		clearTimeout(hoverTimeout);
		setOpen(!open);
	});

	closeBtn.addEventListener("click", (e) => {
		e.stopPropagation();
		clearTimeout(hoverTimeout);
		setOpen(false);
	});

	wrap.addEventListener("mouseenter", () => {
		if (window.matchMedia("(hover: hover)").matches) triggerOpen();
	});

	wrap.addEventListener("mouseleave", () => {
		if (window.matchMedia("(hover: hover)").matches) triggerClose();
	});

	document.addEventListener("pointerdown", (e) => {
		if (open && !wrap.contains(e.target)) setOpen(false);
	});

	document.addEventListener("keydown", (e) => {
		if (e.key === "Escape" && open) {
			setOpen(false);
			btn.focus();
		}
	});

	window.addEventListener("resize", () => {
		if (open) adjustPos();
	}, { passive: true });

	return wrap;
}
