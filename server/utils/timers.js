function unrefTimer(fn, ms) {
	const h = setTimeout(fn, ms);
	if (typeof h.unref === "function") h.unref();
	return h;
}

class Poller {
	constructor({ state, pollMs, onUpdate }) {
		this.state = state;
		this.pollMs = pollMs;
		this.onUpdate = onUpdate;
		this.timer = null;
		this.busy = false;
		this.running = false;
		this._tick = () => this._poll();
	}

	_notify() {
		this.state.dirty = true;
		if (typeof this.onUpdate === "function") {
			try {
				this.onUpdate();
			} catch (err) {
				console.error("[dashboard] poller update callback error:", err.message);
			}
		}
	}

	start() {
		if (this.running) return;
		this.running = true;
		if (this.timer) clearTimeout(this.timer);
		this._poll();
	}

	stop() {
		this.running = false;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
	}

	_schedule() {
		if (this.running) {
			if (this.timer) clearTimeout(this.timer);
			this.timer = unrefTimer(this._tick, this.pollMs);
		}
	}
}

module.exports = { unrefTimer, Poller };
