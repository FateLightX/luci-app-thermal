'use strict';
'require baseclass';

/*
 * Shared sensor naming for the Overview block and the realtime graphs.
 *
 * Kernel identifiers are precise but unreadable: "Package id 0", "temp1",
 * "x86_pkg_temp". Both views must render the same sensor with the same label,
 * so the mapping lives here rather than being copied into each view.
 *
 * The raw identifier is never discarded — the views keep it on the second
 * line of every row, so a reading can still be matched against `sensors`
 * output, a sysfs path or a forum post.
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

function formatTemp(mc) {
	return '%.1f °C'.format(mc / 1000);
}

/* A sensor hidden in the settings page still exists, but no view shows it. */
function visibleSensors(chip) {
	return (chip.sensors || []).filter(s => !s.hidden);
}

/*
 * A stable name for a whole chip, used when several sensors are summarised
 * into one row. It must not follow whichever core happens to be hottest,
 * otherwise the row title changes on every poll.
 */
function chipLabel(chip) {
	const sensors = visibleSensors(chip);
	const first = sensors[0];

	switch (chip.kind) {
	case 'cpu':
		return (sensors.length > 1)
			? _('Processor')
			: (first ? prettyName(chip, first) : _('Processor'));

	case 'disk':
		return first ? prettyName(chip, first) : _('Disk');

	case 'nvme':
		return chip.device
			? '%s — %s'.format(_('NVMe drive'), chip.device)
			: _('NVMe drive');

	case 'wifi':
		return first ? prettyName(chip, first) : _('Wireless');

	case 'board':
		return first ? prettyName(chip, first) : _('Mainboard');

	default:
		return humanize(chip.name);
	}
}

/* Plain-language name for a sensor. Falls back to humanize() so an
   unrecognised chip still reads better than its raw label. */
function prettyName(chip, sensor) {
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
}

return baseclass.extend({
	humanize: humanize,
	formatTemp: formatTemp,
	prettyName: prettyName,
	visibleSensors: visibleSensors,
	chipLabel: chipLabel,
});
