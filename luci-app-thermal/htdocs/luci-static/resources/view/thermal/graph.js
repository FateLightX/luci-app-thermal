'use strict';
'require view';
'require dom';
'require poll';
'require request';
'require rpc';
'require thermal.common as common';

/*
 * Realtime temperature graphs, at Status > Realtime Graphs > Temperature.
 *
 * One graph per chip, so the sensors that share a limit share an axis. A CPU's
 * package and per-core readings belong on one plot; a disk at 54 °C and a CPU
 * core at 42 °C do not, because their critical points are 70 and 105 and a
 * shared axis would misstate both.
 *
 * The y-axis is anchored to each chip's critical point rather than to the
 * observed peak. A trace that sits low IS the good news, and a self-scaling
 * axis would hide it by stretching idle noise to fill the plot.
 */

document.head.append(E('style', { 'type': 'text/css' }, `
.thermal-graph {
	width: 100%;
	height: 300px;
	border: 1px solid var(--border-color-medium, #ccc);
	background: var(--background-color-high, #fff);
}
.thermal-grid {
	stroke: var(--border-color-medium, #ccc);
	stroke-width: 1;
}
.thermal-axis {
	fill: var(--text-color-medium, #808080);
	font-size: 9pt;
	font-family: var(--font-sans, sans-serif);
}
.thermal-trace {
	fill: none;
	stroke: var(--thermal-series);
	stroke-width: 2;
	stroke-linejoin: round;
	stroke-linecap: round;
}
/*
 * Categorical slots in fixed order — colour follows the sensor, never its rank.
 * The hue is declared once as a custom property so the SVG trace (stroke) and
 * the legend key (background) can never drift apart.
 */
.thermal-series-0 { --thermal-series: #2a78d6; }
.thermal-series-1 { --thermal-series: #eb6834; }
.thermal-series-2 { --thermal-series: #1baf7a; }
.thermal-series-3 { --thermal-series: #eda100; }
.thermal-series-4 { --thermal-series: #e87ba4; }
.thermal-series-5 { --thermal-series: #008300; }
.thermal-series-6 { --thermal-series: #4a3aa7; }
.thermal-series-7 { --thermal-series: #e34948; }
[data-darkmode="true"] .thermal-series-0 { --thermal-series: #3987e5; }
[data-darkmode="true"] .thermal-series-1 { --thermal-series: #d95926; }
[data-darkmode="true"] .thermal-series-2 { --thermal-series: #199e70; }
[data-darkmode="true"] .thermal-series-3 { --thermal-series: #c98500; }
[data-darkmode="true"] .thermal-series-4 { --thermal-series: #d55181; }
[data-darkmode="true"] .thermal-series-5 { --thermal-series: #008300; }
[data-darkmode="true"] .thermal-series-6 { --thermal-series: #9085e9; }
[data-darkmode="true"] .thermal-series-7 { --thermal-series: #e66767; }

.thermal-band-warn { fill: var(--warn-color-high, #efbd0b); fill-opacity: 0.10; }
.thermal-band-crit { fill: var(--error-color-medium, #e8210d); fill-opacity: 0.10; }

.thermal-key {
	display: inline-block;
	width: 14px;
	height: 2px;
	margin-right: 6px;
	vertical-align: middle;
	background: var(--thermal-series);
}
/* Rows beyond the plotted limit keep the legend indent without a colour. */
.thermal-key-off { background: transparent; }
.thermal-src {
	font-family: var(--font-mono, monospace);
	font-size: 11px;
	color: var(--text-color-medium, #808080);
}
.thermal-note {
	font-size: 11px;
	color: var(--text-color-medium, #808080);
}
/*
 * State is never carried by colour alone: the row keeps a text label, so it
 * survives greyscale, colour-blindness and forced-colours.
 */
.thermal-row-warn { background-color: rgba(239, 189, 11, 0.12); }
.thermal-row-crit { background-color: rgba(232, 33, 13, 0.12); }
.thermal-state {
	font-size: 11px;
	white-space: nowrap;
}
.thermal-state-warn { color: var(--warn-color-low, #8a6d00); }
.thermal-state-crit { color: var(--error-color-medium, #e8210d); }
[data-darkmode="true"] .thermal-state-warn { color: #d8bd6a; }
`));

const callSensors = rpc.declare({
	object: 'luci.thermal',
	method: 'getSensors',
	expect: { chips: [] },
});

const callTemps = rpc.declare({
	object: 'luci.thermal',
	method: 'getTemps',
	params: [ 'paths' ],
	expect: { temps: {} },
});

const POLL_INTERVAL = 3;
const TOPOLOGY_INTERVAL = 60000;
const SVG_NS = 'http://www.w3.org/2000/svg';

/*
 * The shipped SVG carries eight polylines and the palette has eight slots.
 * Boards with more sensors (a 16-core CPU exposes package + 16 cores) keep
 * every sensor in the table below the graph; only the first eight are drawn,
 * and the page says so instead of dropping them silently.
 */
const MAX_SERIES = 8;

return view.extend({
	chips: [],
	paths: [],
	graphs: [],

	/*
	 * A chip's own title: the shared hardware, not one of its sensors.
	 *
	 * Several chips can describe the same silicon — coretemp and x86_pkg_temp
	 * both report the CPU package. Giving each its own heading is what makes
	 * that duplication legible instead of looking like two identical graphs.
	 */
	chipTitle(chip) {
		return common.chipLabel(chip);
	},

	loadSVG(src) {
		return request.get(src).then(response => {
			if (!response.ok)
				throw new Error(response.statusText);

			return E('div', { 'class': 'thermal-graph' }, E(response.text()));
		});
	},

	/* Width of the box the SVG actually fills; 0 until the view is mounted. */
	graphWidth(svg) {
		if (svg && svg.clientWidth > 0)
			return svg.clientWidth;

		const viewEl = document.querySelector('#view');
		return (viewEl ? viewEl.offsetWidth : 802) - 2;
	},

	/*
	 * The axis top: the critical point, plus a margin so a trace at the limit
	 * is still drawn inside the plot. Rounded up to a clean 10 °C step so the
	 * gridline labels read as temperatures rather than arbitrary fractions.
	 */
	axisPeak(chip) {
		let crit = 0;
		for (const s of common.visibleSensors(chip))
			crit = Math.max(crit, s.crit || 0);

		if (!crit)
			crit = 105000;

		return Math.ceil((crit * 1.1) / 10000) * 10000;
	},

	registerGraph(chip, svg) {
		const width  = this.graphWidth(svg);
		const height = 300 - 2;
		const step   = 5;

		const G = svg.firstElementChild;
		const dataWanted = Math.max(1, Math.floor(width / step));
		const peak = this.axisPeak(chip);
		const scale = height / peak;

		/*
		 * Threshold bands. A chip's sensors can carry different limits, so the
		 * band marks the lowest — the first point at which anything throttles.
		 */
		let hot = Infinity, crit = Infinity;
		for (const s of common.visibleSensors(chip)) {
			if (s.hot)  hot  = Math.min(hot, s.hot);
			/* A limit derived from a hot trip is a throttle point, not a
			   critical one, and must not paint the critical band. */
			if (s.crit && !s.critDerived) crit = Math.min(crit, s.crit);
		}

		const bandWarn = G.getElementById('band_warn');
		const bandCrit = G.getElementById('band_crit');

		if (bandWarn && isFinite(hot)) {
			const top = isFinite(crit) ? crit : peak;
			bandWarn.setAttribute('y', height - top * scale);
			bandWarn.setAttribute('height', Math.max(0, (top - hot) * scale));
		}
		if (bandCrit && isFinite(crit)) {
			bandCrit.setAttribute('y', 0);
			bandCrit.setAttribute('height', Math.max(0, height - crit * scale));
		}

		/* Axis labels are fixed, because the axis itself is fixed. */
		for (const [id, frac] of [['label_25', 0.25], ['label_50', 0.50], ['label_75', 0.75]]) {
			const el = G.getElementById(id);
			if (el)
				el.firstChild.data = '%d °C'.format(frac * peak / 1000);
		}

		const series = common.visibleSensors(chip).map((s, i) => ({
			path: s.path,
			hot: s.hot,
			crit: s.crit,
			critDerived: s.critDerived,
			/* Rows past the palette have no polyline, but they still keep a
			   reading history so min/avg/peak stays correct in the table. */
			el: (i < MAX_SERIES) ? G.getElementById('line_' + i) : null,
			values: new Array(dataWanted).fill(NaN),
			cur: NaN, min: NaN, max: NaN, avg: NaN,
		}));

		const ctx = { chip, svg, width, height, step, dataWanted, peak, scale, series };
		this.graphs.push(ctx);
		this.drawTimeAxis(ctx);
	},

	/* Minute markers, right-aligned so "now" sits at the right edge. */
	drawTimeAxis(ctx) {
		const G = ctx.svg.firstElementChild;

		for (const el of G.querySelectorAll('.thermal-grid-x, .thermal-tick'))
			el.remove();

		for (let i = ctx.width % (ctx.step * 60); i < ctx.width; i += ctx.step * 60) {
			const line = document.createElementNS(SVG_NS, 'line');
			line.setAttribute('x1', i);
			line.setAttribute('y1', 0);
			line.setAttribute('x2', i);
			line.setAttribute('y2', '100%');
			line.setAttribute('class', 'thermal-grid thermal-grid-x');

			const text = document.createElementNS(SVG_NS, 'text');
			text.setAttribute('x', i + 5);
			text.setAttribute('y', 15);
			text.setAttribute('class', 'thermal-axis thermal-tick');
			text.appendChild(document.createTextNode(
				'%dm'.format(Math.round((ctx.width - i) / ctx.step / 60))));

			G.insertBefore(line, G.firstChild);
			G.appendChild(text);
		}
	},

	windowLabel(samples) {
		return _('(%d minute window, %d second interval)')
			.format(Math.round(samples * POLL_INTERVAL / 60), POLL_INTERVAL);
	},

	/*
	 * Window resize, and the first paint after mounting: the box is only
	 * measurable once the section is in the document, so the initial width
	 * taken from #view may be a few pixels off in themes with padding.
	 * History keeps its samples; only the visible tail is re-windowed.
	 */
	resizeGraphs() {
		for (const ctx of this.graphs) {
			const width = this.graphWidth(ctx.svg);
			const dataWanted = Math.max(1, Math.floor(width / ctx.step));

			if (width === ctx.width && dataWanted === ctx.dataWanted)
				continue;

			for (const s of ctx.series) {
				const delta = dataWanted - s.values.length;
				if (delta > 0)
					s.values.unshift(...new Array(delta).fill(NaN));
				else if (delta < 0)
					s.values.splice(0, -delta);
			}

			ctx.width = width;
			ctx.dataWanted = dataWanted;

			this.drawTimeAxis(ctx);
			if (ctx.windowEl)
				dom.content(ctx.windowEl, this.windowLabel(dataWanted));
			this.redraw(ctx);
		}
	},

	onResize() {
		if (this._resizeTimer)
			return;

		this._resizeTimer = window.setTimeout(() => {
			this._resizeTimer = null;
			this.resizeGraphs();
		}, 100);
	},

	redraw(ctx) {
		for (const s of ctx.series) {
			if (!s.el)
				continue;

			let pt = '', started = false;

			for (let j = 0; j < s.values.length; j++) {
				const v = s.values[j];
				if (isNaN(v)) {
					started = false;   /* a gap stays a gap, never a line to zero */
					continue;
				}
				const x = j * ctx.step;
				const y = Math.max(0, ctx.height - v * ctx.scale);
				pt += (started ? ' ' : (pt ? ' ' : '')) + x + ',' + y;
				started = true;
			}

			s.el.setAttribute('points', pt);
		}
	},

	pollData() {
		if (this._pollFn)
			return;

		this._lastTopologyCheck = Date.now();

		this._pollFn = L.bind(function() {
			const due = (Date.now() - this._lastTopologyCheck) >= TOPOLOGY_INTERVAL;
			const calls = [
				this.paths.length
					? L.resolveDefault(callTemps(this.paths), {})
					: Promise.resolve({}),
			];

			if (due)
				calls.push(L.resolveDefault(callSensors(), null));

			return Promise.all(calls).then(L.bind(function(resp) {
				if (due)
					this._lastTopologyCheck = Date.now();

				const chips = resp[1];
				if (Array.isArray(chips) && this.topologySignature(chips) !== this.signature) {
					this.chips = chips;
					this.signature = this.topologySignature(chips);

					/* New hardware invalidates the layout entirely; replace the
					   map in place so the user keeps their page and scroll. */
					const viewEl = document.querySelector('#view');
					const map = this.render([ this.proto, chips ]);
					if (viewEl)
						dom.content(viewEl, map);
					return;
				}

				const readings = L.isObject(resp[0]) ? resp[0] : {};

				for (const ctx of this.graphs) {
					for (const s of ctx.series) {
						const v = readings[s.path];

						s.values.push((v == null) ? NaN : v);
						s.values.shift();

						s.cur = (v == null) ? NaN : v;

						let min = NaN, max = NaN, sum = 0, n = 0;
						for (const x of s.values) {
							if (isNaN(x))
								continue;
							min = isNaN(min) ? x : Math.min(min, x);
							max = isNaN(max) ? x : Math.max(max, x);
							sum += x; n++;
						}
						s.min = min;
						s.max = max;
						s.avg = n ? sum / n : NaN;
					}

					this.redraw(ctx);
					this.updateReadout(ctx);
				}
			}, this));
		}, this);

		poll.add(this._pollFn, POLL_INTERVAL);
	},

	/* Everything a view renders, so a limits change also refreshes the page. */
	topologySignature(chips) {
		return JSON.stringify((chips || []).map(c => [
			c.id, c.name, c.kind, c.device || '',
			(c.sensors || []).map(s => [
				s.path, s.label || '', s.hot, s.crit,
				s.critDerived ? 1 : 0, s.assumed ? 1 : 0, s.hidden ? 1 : 0,
			]),
		]));
	},

	updateReadout(ctx) {
		for (const s of ctx.series) {
			if (!s.row)
				continue;
			for (const [key, val] of [['cur', s.cur], ['min', s.min], ['avg', s.avg], ['max', s.max]]) {
				const cell = s.row.querySelector('[data-stat="%s"]'.format(key));
				if (cell)
					dom.content(cell, isNaN(val) ? '-' : common.formatTemp(val));
			}
			this.updateState(s);
		}
	},

	/*
	 * Mark a row that has crossed its own trip point. Threshold order is not
	 * guaranteed by the kernel, so warn only counts when it sits below crit.
	 */
	updateState(s) {
		const cell = s.row.querySelector('[data-state]');
		if (!cell)
			return;

		let cls = '', text = '';

		if (!isNaN(s.cur)) {
			/* Only a kernel-reported critical point may turn a row red. */
			if (s.crit && !s.critDerived && s.cur >= s.crit) {
				cls = 'crit';
				text = _('critical');
			}
			else if (s.hot && (s.critDerived || s.hot < s.crit) && s.cur >= s.hot) {
				cls = 'warn';
				text = _('throttling');
			}
		}

		s.row.setAttribute('class', 'tr' + (cls ? ' thermal-row-' + cls : ''));
		cell.setAttribute('class', 'td left thermal-state'
			+ (cls ? ' thermal-state-' + cls : ''));
		dom.content(cell, text);
	},

	load() {
		return Promise.all([
			this.loadSVG(L.resource('svg/thermal.svg')),
			L.resolveDefault(callSensors(), []),
		]).then(L.bind(function(data) {
			this.proto = data[0];
			this.signature = this.topologySignature(data[1]);
			return data;
		}, this));
	},

	render(data) {
		const proto = data[0] || this.proto;
		this.proto = proto;
		this.chips = Array.isArray(data[1]) ? data[1] : [];
		this.signature = this.topologySignature(this.chips);
		this.graphs = [];
		this.paths = [];

		const map = E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, _('Temperature')),
			E('div', { 'class': 'cbi-map-descr' },
				_('Live readings from every temperature sensor the kernel exposes. Each graph is scaled to that device\'s own critical point, so a low trace means real headroom.')),
		]);

		if (!this.chips.length) {
			map.appendChild(E('div', { 'class': 'cbi-section' },
				E('em', {}, _('No temperature sensors detected.'))));
			/* Keep polling so hardware plugged in later still appears. */
			this.pollData();
			return map;
		}

		let anyAssumed = false;

		for (const chip of this.chips) {
			const sensors = common.visibleSensors(chip);
			if (!sensors.length)
				continue;

			for (const s of sensors)
				this.paths.push(s.path);

			const svg = proto.cloneNode(true);
			this.registerGraph(chip, svg);
			const ctx = this.graphs[this.graphs.length - 1];

			const table = E('table', { 'class': 'table' }, [
				E('tr', { 'class': 'tr table-titles' }, [
					E('th', { 'class': 'th left' }, _('Sensor')),
					E('th', { 'class': 'th left' }, _('Current')),
					E('th', { 'class': 'th left' }, _('Minimum')),
					E('th', { 'class': 'th left' }, _('Average')),
					E('th', { 'class': 'th left' }, _('Peak')),
					E('th', { 'class': 'th left' }, _('Limit')),
					E('th', { 'class': 'th left' }, _('State')),
				]),
			]);

			sensors.forEach((sensor, i) => {
				if (sensor.assumed)
					anyAssumed = true;

				const limit = sensor.assumed
					? _('%s assumed').format(common.formatTemp(sensor.crit))
					: sensor.critDerived
						? _('%s throttling limit').format(common.formatTemp(sensor.crit))
						: common.formatTemp(sensor.crit);

				const row = E('tr', { 'class': 'tr' }, [
					E('td', { 'class': 'td left top' }, [
						(i < MAX_SERIES)
							? E('span', { 'class': 'thermal-key thermal-series-%d'.format(i) })
							: E('span', { 'class': 'thermal-key thermal-key-off' }),
						common.prettyName(chip, sensor),
						E('div', { 'class': 'thermal-src' }, sensor.path),
					]),
					E('td', { 'class': 'td left', 'data-stat': 'cur' }, '-'),
					E('td', { 'class': 'td left', 'data-stat': 'min' }, '-'),
					E('td', { 'class': 'td left', 'data-stat': 'avg' }, '-'),
					E('td', { 'class': 'td left', 'data-stat': 'max' }, '-'),
					E('td', { 'class': 'td left' }, limit),
					E('td', { 'class': 'td left thermal-state', 'data-state': '' }, ''),
				]);

				ctx.series[i].row = row;
				table.appendChild(row);
			});

			const windowEl = E('small', {}, this.windowLabel(ctx.dataWanted));
			ctx.windowEl = windowEl;

			map.appendChild(E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, this.chipTitle(chip)),
				svg,
				(sensors.length > MAX_SERIES)
					? E('div', { 'class': 'thermal-note' },
						_('Plotting %d of %d sensors; all readings are listed below.')
							.format(MAX_SERIES, sensors.length))
					: null,
				E('div', { 'class': 'right' }, windowEl),
				E('br'),
				table,
			]));
		}

		if (anyAssumed)
			map.appendChild(E('div', { 'class': 'cbi-section' },
				E('p', { 'class': 'thermal-note' },
					_('Limits shown as assumed are not reported by the kernel for that sensor; a default for the device class is used instead.'))));

		this.pollData();

		/* Measure the mounted box, and keep the traces in step with resizes. */
		if (!this._resizeHandler) {
			this._resizeHandler = () => this.onResize();
			window.addEventListener('resize', this._resizeHandler);
		}
		this.onResize();

		return map;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null,
});
