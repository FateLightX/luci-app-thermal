'use strict';
'require view';
'require dom';
'require poll';
'require request';
'require rpc';

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

/* Naming — see 29_thermal.js; kept in step with it deliberately. */
const ACRONYMS = {
	cpu: 'CPU', gpu: 'GPU', npu: 'NPU', vpu: 'VPU', tpu: 'TPU',
	ddr: 'DDR', soc: 'SoC', pmic: 'PMIC', pch: 'PCH', mcu: 'MCU',
	nvme: 'NVMe', ssd: 'SSD', hdd: 'HDD', wifi: 'Wi-Fi', ap: 'AP',
};

function humanize(s) {
	return String(s)
		.replace(/_(thermal|temp|thermal_zone)$/, '')
		.split(/[_\-\s]+/)
		.filter(Boolean)
		.map((w, i) => ACRONYMS[w.toLowerCase()]
			|| (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
		.join(' ') || String(s);
}

return view.extend({
	chips: [],
	paths: [],
	graphs: [],

	formatTemp(mc) {
		return '%.1f °C'.format(mc / 1000);
	},

	prettyName(chip, sensor) {
		const chipName = String(chip.name || '').toLowerCase();
		const label = String(sensor.label || '');
		let m;

		switch (chip.kind) {
		case 'cpu':
			if ((m = label.match(/^Package id (\d+)$/)))
				return (m[1] === '0') ? _('CPU package')
				                      : _('CPU package %d').format(m[1]);
			if ((m = label.match(/^Core (\d+)$/)))
				return _('CPU core %d').format(m[1]);
			if ((m = label.match(/^Tccd(\d+)$/i)))
				return _('CPU die %d').format(m[1]);
			if (chipName === 'x86_pkg_temp')
				return _('CPU package (thermal zone)');
			if ((m = chipName.match(/^bigcore(\d+)/)))
				return _('CPU big core %d').format(m[1]);
			if (chipName.indexOf('littlecore') === 0)
				return _('CPU little cores');
			return humanize(chipName);

		case 'disk':
			return label ? '%s — %s'.format(_('Disk'), label) : _('Disk');

		case 'nvme':
			if (/^Composite$/i.test(label))
				return _('NVMe drive');
			if ((m = label.match(/^Sensor (\d+)$/i)))
				return _('NVMe sensor %d').format(m[1]);
			return label ? '%s — %s'.format(_('NVMe drive'), label) : _('NVMe drive');

		case 'wifi':
			if ((m = chipName.match(/phy(\d+)/)))
				return _('Wi-Fi radio %d').format(m[1]);
			return _('Wi-Fi radio');

		case 'board':
			if (chipName === 'acpitz')
				return _('Mainboard (ACPI)');
			if (chipName.indexOf('pch') >= 0)
				return _('Chipset (PCH)');
			return _('Mainboard');

		default:
			return humanize(label && !/^temp\d+$/.test(label) ? label : chipName);
		}
	},

	/*
	 * A chip's own title: the shared hardware, not one of its sensors.
	 *
	 * Several chips can describe the same silicon — coretemp and x86_pkg_temp
	 * both report the CPU package. Giving each its own heading is what makes
	 * that duplication legible instead of looking like two identical graphs.
	 */
	chipTitle(chip) {
		const sensors = chip.sensors || [];
		const first = sensors[0];

		switch (chip.kind) {
		case 'cpu':
			/* One sensor means this chip is a single view of the CPU rather
			   than the per-core bank, so name that view specifically. */
			if (sensors.length === 1 && first)
				return this.prettyName(chip, first);
			return _('Processor');
		case 'disk':  return first ? this.prettyName(chip, first) : _('Disk');
		case 'nvme':  return _('NVMe drive');
		case 'wifi':  return first ? this.prettyName(chip, first) : _('Wireless');
		case 'board': return first ? this.prettyName(chip, first) : _('Mainboard');
		default:      return humanize(chip.name);
		}
	},

	loadSVG(src) {
		return request.get(src).then(response => {
			if (!response.ok)
				throw new Error(response.statusText);

			return E('div', { 'class': 'thermal-graph' }, E(response.text()));
		});
	},

	/*
	 * The axis top: the critical point, plus a margin so a trace at the limit
	 * is still drawn inside the plot. Rounded up to a clean 10 °C step so the
	 * gridline labels read as temperatures rather than arbitrary fractions.
	 */
	axisPeak(chip) {
		let crit = 0;
		for (const s of (chip.sensors || []))
			crit = Math.max(crit, s.crit || 0);

		if (!crit)
			crit = 105000;

		return Math.ceil((crit * 1.1) / 10000) * 10000;
	},

	registerGraph(chip, svg) {
		const viewEl = document.querySelector('#view');
		const width  = (viewEl ? viewEl.offsetWidth : 800) - 2;
		const height = 300 - 2;
		const step   = 5;

		const G = svg.firstElementChild;
		const dataWanted = Math.floor(width / step);
		const peak = this.axisPeak(chip);
		const scale = height / peak;

		/* Minute markers, right-aligned so "now" sits at the right edge. */
		for (let i = width % (step * 60); i < width; i += step * 60) {
			const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
			line.setAttribute('x1', i);
			line.setAttribute('y1', 0);
			line.setAttribute('x2', i);
			line.setAttribute('y2', '100%');
			line.setAttribute('class', 'thermal-grid');

			const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
			text.setAttribute('x', i + 5);
			text.setAttribute('y', 15);
			text.setAttribute('class', 'thermal-axis');
			text.appendChild(document.createTextNode(
				'%dm'.format(Math.round((width - i) / step / 60))));

			G.insertBefore(line, G.firstChild);
			G.appendChild(text);
		}

		/*
		 * Threshold bands. A chip's sensors can carry different limits, so the
		 * band marks the lowest — the first point at which anything throttles.
		 */
		let hot = Infinity, crit = Infinity;
		for (const s of (chip.sensors || [])) {
			if (s.hot)  hot  = Math.min(hot, s.hot);
			if (s.crit) crit = Math.min(crit, s.crit);
		}

		const bandWarn = G.getElementById('band_warn');
		const bandCrit = G.getElementById('band_crit');

		if (bandWarn && isFinite(hot) && isFinite(crit) && hot < crit) {
			bandWarn.setAttribute('y', height - crit * scale);
			bandWarn.setAttribute('height', Math.max(0, (crit - hot) * scale));
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

		const series = (chip.sensors || []).slice(0, 8).map((s, i) => ({
			path: s.path,
			hot: s.hot,
			crit: s.crit,
			el: G.getElementById('line_' + i),
			values: new Array(dataWanted).fill(NaN),
			cur: NaN, min: NaN, max: NaN, avg: NaN,
		}));

		this.graphs.push({ chip, svg, width, height, step, dataWanted, peak, scale, series });
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
		poll.add(L.bind(function() {
			if (!this.paths.length)
				return Promise.resolve();

			return L.resolveDefault(callTemps(this.paths), {}).then(L.bind(function(temps) {
				const readings = L.isObject(temps) ? temps : {};

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
		}, this), POLL_INTERVAL);
	},

	updateReadout(ctx) {
		for (const s of ctx.series) {
			if (!s.row)
				continue;
			for (const [key, val] of [['cur', s.cur], ['min', s.min], ['avg', s.avg], ['max', s.max]]) {
				const cell = s.row.querySelector('[data-stat="%s"]'.format(key));
				if (cell)
					dom.content(cell, isNaN(val) ? '-' : this.formatTemp(val));
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
			if (s.crit && s.cur >= s.crit) {
				cls = 'crit';
				text = _('critical');
			}
			else if (s.hot && s.crit && s.hot < s.crit && s.cur >= s.hot) {
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
		]);
	},

	render(data) {
		const proto = data[0];
		this.chips = Array.isArray(data[1]) ? data[1] : [];

		const map = E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, _('Temperature')),
			E('div', { 'class': 'cbi-map-descr' },
				_('Live readings from every temperature sensor the kernel exposes. Each graph is scaled to that device\'s own critical point, so a low trace means real headroom.')),
		]);

		if (!this.chips.length) {
			map.appendChild(E('div', { 'class': 'cbi-section' },
				E('em', {}, _('No temperature sensors detected.'))));
			return map;
		}

		this.paths = [];
		let anyAssumed = false;

		for (const chip of this.chips) {
			const sensors = (chip.sensors || []).slice(0, 8);
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
					? _('%s assumed').format(this.formatTemp(sensor.crit))
					: this.formatTemp(sensor.crit);

				const row = E('tr', { 'class': 'tr' }, [
					E('td', { 'class': 'td left top' }, [
						E('span', { 'class': 'thermal-key thermal-series-%d'.format(i) }),
						this.prettyName(chip, sensor),
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

			map.appendChild(E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, this.chipTitle(chip)),
				svg,
				E('div', { 'class': 'right' },
					E('small', {}, _('(%d minute window, %d second interval)')
						.format(Math.round(ctx.dataWanted * POLL_INTERVAL / 60), POLL_INTERVAL))),
				E('br'),
				table,
			]));
		}

		if (anyAssumed)
			map.appendChild(E('div', { 'class': 'cbi-section' },
				E('p', { 'class': 'thermal-note' },
					_('Limits shown as assumed are not reported by the kernel for that sensor; a default for the device class is used instead.'))));

		this.pollData();

		return map;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null,
});
