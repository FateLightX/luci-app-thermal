'use strict';
'require view';
'require form';
'require rpc';
'require uci';
'require thermal.common as common';

const callSensors = rpc.declare({
	object: 'luci.thermal',
	method: 'getSensors',
	expect: { chips: [] },
});

return view.extend({
	load() {
		return Promise.all([
			L.resolveDefault(callSensors(), []),
			uci.load('thermal')
				.then(() => uci.sections('thermal', 'sensor'))
				.catch(() => []),
		]);
	},

	render(data) {
		const chips = Array.isArray(data) ? data[0] : data;
		const configured = Array.isArray(data) ? (data[1] || []) : [];
		const sensors = [];
		const known = {};

		for (const chip of (Array.isArray(chips) ? chips : [])) {
			for (const s of (chip.sensors || [])) {
				sensors.push({
					path: s.path,
					label: '%s — %s'.format(common.prettyName(chip, s),
						chip.device || s.path.split('/').slice(-2).join('/')),
				});
				known[s.path] = true;
			}
		}

		/* A sensor that is currently unplugged must stay editable, otherwise
		   its override would silently disappear from the form. */
		for (const section of configured) {
			if (!section.path || known[section.path])
				continue;
			sensors.push({
				path: section.path,
				label: '%s (%s)'.format(section.path.split('/').slice(-2).join('/'),
					_('not detected')),
			});
			known[section.path] = true;
		}

		sensors.sort((a, b) => a.label.localeCompare(b.label));

		const m = new form.Map('thermal', _('Temperature limits'),
			_('Override warning and critical limits per sensor, or hide a sensor from the status pages.'));

		const s = m.section(form.GridSection, 'sensor', _('Sensor overrides'));
		s.anonymous = true;
		s.addremove = true;
		s.sortable = false;

		let o = s.option(form.ListValue, 'path', _('Sensor'));
		o.rmempty = false;
		for (const item of sensors)
			o.value(item.path, item.label);

		o = s.option(form.Value, 'hot', _('Throttle limit (°C)'),
			_('Leave empty to keep the kernel-reported value or the device-class default.'));
		o.datatype = 'and(ufloat,range(0,200))';
		o.placeholder = '60';

		o = s.option(form.Value, 'crit', _('Critical limit (°C)'),
			_('Leave empty to keep the kernel-reported value or the device-class default.'));
		o.datatype = 'and(ufloat,range(0,200))';
		o.placeholder = '70';

		o = s.option(form.Flag, 'hidden', _('Hidden'));
		o.default = '0';
		o.rmempty = false;

		return m.render();
	},
});
