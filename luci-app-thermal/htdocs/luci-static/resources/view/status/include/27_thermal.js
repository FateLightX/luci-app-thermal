'use strict';
'require baseclass';
'require rpc';
'require thermal.common as common';

/*
 * Temperature block for Status > Overview.
 *
 * The status page driver (view/status/index.js) supplies the surrounding
 * .cbi-section, the <h3> title and the Show/Hide toggle, and re-invokes
 * load()/render() on every poll tick. This module therefore returns only
 * the table, and keeps no chrome of its own.
 *
 * Presentation rests on .cbi-progressbar, the same mark the Memory and
 * Storage blocks use for "current value against a limit", so a temperature
 * row reads exactly like the rows above it.
 */

document.head.append(E('style', { 'type': 'text/css' }, `
.thermal-src {
	font-family: var(--font-mono, monospace);
	font-size: 11px;
	color: var(--text-color-medium, #808080);
}
.thermal-bar[data-state="warn"] > div { background: var(--warn-color-low, #f2d24f); }
.thermal-bar[data-state="crit"] > div { background: var(--error-color-medium, #e8210d); }
.thermal-trip {
	position: absolute;
	top: -2px;
	bottom: -2px;
	width: 1px;
	background: var(--text-color-medium, #808080);
}
.thermal-note {
	font-size: 11px;
	color: var(--text-color-medium, #808080);
	margin: 4px 0 0 0;
}
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

/* Re-walk sysfs at most once a minute; readings still poll every tick. */
const SCAN_INTERVAL = 60000;

return baseclass.extend({
	title: _('Temperature'),

	/* Topology is refreshed once a minute; readings poll on every tick. */
	chips: null,
	paths: [],
	lastScan: 0,

	/* The exact identifiers the kernel uses, kept visible under every row. */
	rawLine(chip, sensor) {
		const parts = [ chip.detail || chip.name ];
		const label = String(sensor.label || '');
		/* The drive model is already the headline for disks; everywhere else
		   the raw label is the string `sensors` prints, so it earns its place. */
		if (label && chip.kind !== 'disk' && String(parts[0]).indexOf(label) < 0)
			parts.push(label);
		return parts.join(' · ');
	},

	stateOf(temp, sensor) {
		/* A limit derived from a hot trip means throttling, not critical. */
		if (!sensor.critDerived && temp >= sensor.crit)
			return 'crit';
		if (temp >= sensor.hot)
			return 'warn';
		return 'ok';
	},

	progressbar(temp, sensor) {
		const scale = sensor.crit > 0 ? sensor.crit
		            : sensor.hot > 0 ? sensor.hot : 1;
		const pct = Math.max(0, Math.min(100, (temp / scale) * 100));
		const limitLabel = sensor.assumed
			? _('%s assumed limit').format(common.formatTemp(sensor.crit))
			: sensor.critDerived
				? _('%s throttling limit').format(common.formatTemp(sensor.crit))
				: _('%s critical').format(common.formatTemp(sensor.crit));

		const bar = E('div', {
			'class': 'cbi-progressbar thermal-bar',
			'data-state': this.stateOf(temp, sensor),
			'title': '%s / %s (%d%%)'.format(common.formatTemp(temp), limitLabel, pct),
		}, E('div', { 'style': 'width:%.2f%%'.format(pct) }));

		/* Mark where throttling begins, when that is below the critical point. */
		if (!sensor.critDerived && sensor.hot < sensor.crit) {
			bar.appendChild(E('i', {
				'class': 'thermal-trip',
				'style': 'left:%.2f%%'.format((sensor.hot / scale) * 100),
			}));
		}

		return bar;
	},

	load() {
		if (this.chips && this.chips.length && (Date.now() - this.lastScan) < SCAN_INTERVAL)
			return this.loadTemps();

		/*
		 * Discovery is retried until it yields something — rpcd may still be
		 * starting during the first poll tick — and revisited once a minute
		 * afterwards, so a disk plugged in later shows up without a reload.
		 * A failed or empty scan never discards a table that already works.
		 */
		return L.resolveDefault(callSensors(), []).then(L.bind(function(chips) {
			const next = Array.isArray(chips) ? chips : [];
			this.lastScan = Date.now();

			if (!next.length && this.chips && this.chips.length)
				return this.loadTemps();

			this.chips = next;
			this.paths = [];
			const seed = {};
			for (const chip of this.chips) {
				for (const s of common.visibleSensors(chip)) {
					this.paths.push(s.path);
					seed[s.path] = s.temp;   /* first paint uses discovery values */
				}
			}
			return seed;
		}, this));
	},

	/* Readings only; used by the fast path and after a topology change. */
	loadTemps() {
		return this.paths.length
			? L.resolveDefault(callTemps(this.paths), {})
			: Promise.resolve({});
	},

	render(temps) {
		if (!this.chips || !this.chips.length)
			return E('em', {}, _('No temperature sensors detected.'));

		const readings = L.isObject(temps) ? temps : {};
		const table = E('table', { 'class': 'table' });
		let anyAssumed = false;
		let summarised = 0;

		for (const chip of this.chips) {
			const sensors = common.visibleSensors(chip);
			if (!sensors.length)
				continue;

			/* One row per chip: a 16-core CPU would otherwise push every block
			   below it off the page. The graphs keep the per-sensor detail. */
			const sensor = this.hottest(sensors, readings);
			if (sensors.length > 1)
				summarised++;

			const temp = readings[sensor.path];

			if (sensor.assumed)
				anyAssumed = true;

			table.appendChild(E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td left top', 'width': '33%' }, [
					E('div', {}, common.chipLabel(chip)),
					E('div', { 'class': 'thermal-src' }, this.rawLine(chip, sensor)),
				]),
				E('td', { 'class': 'td left' }, [
					(temp != null)
						? this.progressbar(temp, sensor)
						: E('em', {}, _('no reading')),
				]),
			]));
		}

		if (!table.childNodes.length)
			return E('em', {}, _('No temperature sensors detected.'));

		const out = E([], [ table ]);

		if (summarised) {
			out.appendChild(E('p', { 'class': 'thermal-note' }, [
				_('One row per chip, showing its hottest sensor.'),
				' ',
				E('a', { 'href': L.url('admin/status/realtime/thermal') }, _('All sensors')),
			]));
		}

		/* Never let a guessed limit pass as a kernel-reported one. */
		if (anyAssumed) {
			out.appendChild(E('p', { 'class': 'thermal-note' },
				_('Limits shown as assumed are not reported by the kernel for that sensor; a default for the device class is used instead.')));
		}

		return out;
	},

	/* The sensor to represent a chip with: the hottest readable one. */
	hottest(sensors, readings) {
		let best = null, bestTemp = -Infinity;

		for (const s of sensors) {
			const t = readings[s.path];
			if (t == null)
				continue;
			if (best == null || t > bestTemp) {
				best = s;
				bestTemp = t;
			}
		}

		return best || sensors[0];
	},
});
