'use strict';
'require baseclass';
'require rpc';

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

/*
 * Kernel sensor identifiers are precise but unreadable: "Package id 0",
 * "temp1", "x86_pkg_temp". These are mapped to plain names here rather than
 * in the backend, so the backend keeps reporting raw facts and the strings
 * stay translatable.
 *
 * The raw identifier is never discarded — it stays on the second line of
 * every row, so a reading can still be matched against `sensors` output,
 * a sysfs path or a forum post.
 */
const ACRONYMS = {
	cpu: 'CPU', gpu: 'GPU', npu: 'NPU', vpu: 'VPU', tpu: 'TPU',
	ddr: 'DDR', soc: 'SoC', pmic: 'PMIC', pch: 'PCH', mcu: 'MCU',
	nvme: 'NVMe', ssd: 'SSD', hdd: 'HDD', wifi: 'Wi-Fi', ap: 'AP',
};

/* Last-resort tidy-up for zone types this build has never seen. */
function humanize(s) {
	return String(s)
		.replace(/_(thermal|temp|thermal_zone)$/, '')
		.split(/[_\-\s]+/)
		.filter(Boolean)
		.map((w, i) => ACRONYMS[w.toLowerCase()]
			|| (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
		.join(' ') || String(s);
}

return baseclass.extend({
	title: _('Temperature'),

	/* Topology is read once; only the readings are polled after that. */
	chips: null,
	paths: [],

	formatTemp(mc) {
		return '%.1f °C'.format(mc / 1000);
	},

	/* Plain-language name for a sensor. Falls back to humanize() so an
	   unrecognised chip still reads better than its raw label. */
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
			/* Thermal-zone view of the same package sensor coretemp reports.
			   Naming it plainly is what makes the duplicate legible. */
			if (chipName === 'x86_pkg_temp')
				return _('CPU package (thermal zone)');
			if ((m = chipName.match(/^bigcore(\d+)/)))
				return _('CPU big core %d').format(m[1]);
			if (chipName.indexOf('littlecore') === 0)
				return _('CPU little cores');
			return humanize(chipName);

		case 'disk':
			/* label is the drive model, resolved by the backend. */
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
		if (temp >= sensor.crit)
			return 'crit';
		if (temp >= sensor.hot)
			return 'warn';
		return 'ok';
	},

	progressbar(temp, sensor) {
		const pct = Math.max(0, Math.min(100, (temp / sensor.crit) * 100));
		const limitLabel = sensor.assumed
			? _('%s assumed limit').format(this.formatTemp(sensor.crit))
			: _('%s critical').format(this.formatTemp(sensor.crit));

		const bar = E('div', {
			'class': 'cbi-progressbar thermal-bar',
			'data-state': this.stateOf(temp, sensor),
			'title': '%s / %s (%d%%)'.format(this.formatTemp(temp), limitLabel, pct),
		}, E('div', { 'style': 'width:%.2f%%'.format(pct) }));

		/* Mark where throttling begins, when that is below the critical point. */
		if (sensor.hot < sensor.crit) {
			bar.appendChild(E('i', {
				'class': 'thermal-trip',
				'style': 'left:%.2f%%'.format((sensor.hot / sensor.crit) * 100),
			}));
		}

		return bar;
	},

	load() {
		if (this.chips && this.chips.length)
			return this.paths.length
				? L.resolveDefault(callTemps(this.paths), {})
				: Promise.resolve({});

		/*
		 * Discovery is retried until it yields something. rpcd may still be
		 * starting during the first poll tick, and an empty result must not
		 * latch the block into a permanent "no sensors" state.
		 */
		return L.resolveDefault(callSensors(), []).then(L.bind(function(chips) {
			this.chips = Array.isArray(chips) ? chips : [];
			this.paths = [];
			const seed = {};
			for (const chip of this.chips) {
				for (const s of (chip.sensors || [])) {
					this.paths.push(s.path);
					seed[s.path] = s.temp;   /* first paint uses discovery values */
				}
			}
			return seed;
		}, this));
	},

	render(temps) {
		if (!this.chips || !this.chips.length)
			return E('em', {}, _('No temperature sensors detected.'));

		const readings = L.isObject(temps) ? temps : {};
		const table = E('table', { 'class': 'table' });
		let anyAssumed = false;

		for (const chip of this.chips) {
			for (const sensor of (chip.sensors || [])) {
				const temp = readings[sensor.path];

				if (sensor.assumed)
					anyAssumed = true;

				table.appendChild(E('tr', { 'class': 'tr' }, [
					E('td', { 'class': 'td left top', 'width': '33%' }, [
						E('div', {}, this.prettyName(chip, sensor)),
						E('div', { 'class': 'thermal-src' }, this.rawLine(chip, sensor)),
					]),
					E('td', { 'class': 'td left' }, [
						(temp != null)
							? this.progressbar(temp, sensor)
							: E('em', {}, _('no reading')),
					]),
				]));
			}
		}

		if (!table.childNodes.length)
			return E('em', {}, _('No temperature sensors detected.'));

		const out = E([], [ table ]);

		/* Never let a guessed limit pass as a kernel-reported one. */
		if (anyAssumed) {
			out.appendChild(E('p', { 'class': 'thermal-note' },
				_('Limits shown as assumed are not reported by the kernel for that sensor; a default for the device class is used instead.')));
		}

		return out;
	},
});
