'use strict';

// Exercise the real LuCI loader, including its dependency and constructor
// checks. Pass a directory containing luci.js and cbi.js to test a router's
// runtime; otherwise download a pinned upstream runtime. No npm dependencies.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const revision = '4bfd1102236f7f737da4257ca7f6e56146fc80f6';
const upstream = `https://raw.githubusercontent.com/openwrt/luci/${revision}/modules/luci-base/htdocs/luci-static/resources`;
const runtime = Object.fromEntries(['luci.js', 'cbi.js'].map(name => [name,
	process.argv[2]
		? readFileSync(path.join(process.argv[2], name), 'utf8')
		: execFileSync('curl', ['--fail', '--silent', '--show-error',
			'--max-time', '30', '--retry', '2', `${upstream}/${name}`], { encoding: 'utf8' }),
]));

async function loadCommon(source) {
	// Browser bootstrap and rendering are outside this module-loading test.
	const context = vm.createContext({
		document: { addEventListener() {}, querySelector() { return null; } },
		DOMParser: class {},
	});
	vm.runInContext('window = globalThis;', context);
	for (const name of ['cbi.js', 'luci.js'])
		vm.runInContext(runtime[name], context, { filename: name });
	vm.runInContext(`
		L = Object.create(LuCI.prototype);
		L.env.base_url = '/luci-static/resources';
		E = () => null;
	`, context);
	context.L.Request.get = async url => {
		assert.equal(url, '/luci-static/resources/thermal/common.js');
		return { ok: true, status: 200, url, text: () => source };
	};
	return { common: await context.L.require('thermal.common'), L: context.L };
}

async function main() {
	// Prove that this harness rejects the original failure, not just bad syntax.
	await assert.rejects(loadCommon("'use strict'; return {};"),
		/"thermal\.common" factory yields invalid constructor/);

	const source = readFileSync(path.join(__dirname,
		'../luci-app-thermal/htdocs/luci-static/resources/thermal/common.js'), 'utf8');
	const { common, L } = await loadCommon(source);
	assert(common instanceof L.Class);
	assert.equal(await L.require('thermal.common'), common);
	for (const method of ['humanize', 'formatTemp', 'prettyName', 'visibleSensors', 'chipLabel'])
		assert.equal(typeof common[method], 'function', method);

	assert.equal(common.humanize('cpu_thermal'), 'CPU');
	assert.equal(common.formatTemp(42500), '42.5 °C');
	assert.equal(common.prettyName({ kind: 'cpu', name: 'coretemp' },
		{ label: 'Core 2' }), 'CPU core 2');
	const visible = { label: 'Package id 0' };
	const hidden = { label: 'Core 0', hidden: true };
	const chip = { kind: 'cpu', name: 'coretemp', sensors: [visible, hidden] };
	assert.deepEqual(common.visibleSensors(chip), [visible]);
	assert.equal(common.chipLabel(chip), 'CPU package');
	console.log('LuCI common OK: invalid export rejected; module loads and helpers work');
}

main().catch(error => {
	console.error(error);
	process.exitCode = 1;
});
