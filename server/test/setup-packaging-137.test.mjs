import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSetupUiBundle, missingSetupUiFiles, setupUiDiagnostic, setupUiFiles } from '../homelab/ui-bundle.mjs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const serverDirectory = path.join(repoRoot, 'server');
const dockerfile = readFileSync(path.join(serverDirectory, 'Dockerfile'), 'utf8');
const dockerignore = readFileSync(path.join(serverDirectory, '.dockerignore'), 'utf8');

function tempDirectory(t, prefix) {
	const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	return directory;
}

// Build-context helpers. These mirror the small subset of Docker syntax this
// repository uses so the test can state the packaging contract directly.
function normalizeBuildPath(value) {
	return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/').replace(/^\/+/, '').replace(/\/+$/, '') || '.';
}

function copyArguments(value) {
	const trimmed = value.trim();
	if (trimmed.startsWith('[')) {
		try {
			const parsed = JSON.parse(trimmed);
			if (Array.isArray(parsed)) return parsed.map(String);
		} catch { /* fall through to whitespace splitting */ }
	}
	return trimmed.split(/\s+/);
}

export function copyInstructions(text) {
	const instructions = [];
	for (const raw of text.split(/\r?\n/)) {
		const match = /^\s*COPY\s+(?:--\S+\s+)*(.+)$/i.exec(raw);
		if (!match) continue;
		const parts = copyArguments(match[1]);
		if (parts.length < 2) continue;
		const destination = parts[parts.length - 1];
		for (const source of parts.slice(0, -1)) instructions.push({ source, destination });
	}
	return instructions;
}

export function copyCovers(dockerfileText, relative) {
	const target = normalizeBuildPath(relative);
	for (const { source } of copyInstructions(dockerfileText)) {
		const normalized = normalizeBuildPath(source);
		// Exact sources and source directories only: globs are not treated as
		// proof that a specific file reaches the image.
		if (/[*?[]/.test(normalized)) continue;
		if (normalized === '.') return true;
		if (target === normalized || target.startsWith(normalized + '/')) return true;
	}
	return false;
}

function globExpression(pattern) {
	let source = '';
	for (let index = 0; index < pattern.length; index++) {
		const character = pattern[index];
		if (character === '*') {
			if (pattern[index + 1] === '*') {
				index++;
				if (pattern[index + 1] === '/') { index++; source += '(?:.*/)?'; }
				else source += '.*';
			} else source += '[^/]*';
		} else if (character === '?') source += '[^/]';
		else if ('\\^$+.()|{}[]'.includes(character)) source += '\\' + character;
		else source += character;
	}
	return new RegExp('^' + source + '$');
}

function patternCovers(pattern, relative) {
	const segments = relative.split('/');
	const candidates = [];
	if (pattern.includes('/')) {
		for (let index = 1; index <= segments.length; index++) candidates.push(segments.slice(0, index).join('/'));
	} else {
		candidates.push(...segments);
	}
	const expression = globExpression(pattern);
	return candidates.some(candidate => expression.test(candidate));
}

export function dockerignoreIgnores(dockerignoreText, relative) {
	const target = normalizeBuildPath(relative);
	let ignored = false;
	for (const raw of dockerignoreText.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith('#')) continue;
		const negated = line.startsWith('!');
		const pattern = normalizeBuildPath(negated ? line.slice(1) : line);
		if (!pattern) continue;
		if (pattern === '**') { ignored = !negated; continue; }
		if (patternCovers(pattern, target)) ignored = !negated;
	}
	return ignored;
}

test('the container build context copies the whole setup UI bundle into /app', () => {
	assert.match(dockerfile, /^\s*WORKDIR\s+\/app\s*$/m, 'WORKDIR must be /app so relative COPY destinations land in the image root');
	assert.match(dockerfile, /^\s*CMD\s+\[.*homelab\/launch\.mjs"?\]/m);

	for (const directory of ['homelab', 'public', 'relay-media']) {
		const copies = copyInstructions(dockerfile).filter(instruction => normalizeBuildPath(instruction.source) === directory);
		assert.ok(copies.length, 'Dockerfile must COPY the whole ' + directory + ' directory');
		for (const copy of copies) {
			const destination = normalizeBuildPath(copy.destination);
			assert.ok(
				destination === directory || destination === 'app/' + directory,
				'COPY ' + directory + ' must land at ./' + directory + ' or /app/' + directory + ' but used ' + copy.destination
			);
		}
	}

	for (const file of setupUiFiles) {
		const absolute = path.join(serverDirectory, 'homelab', 'public', file);
		assert.equal(statSync(absolute).isFile(), true, 'homelab/public/' + file + ' must exist in the source tree');
		assert.equal(copyCovers(dockerfile, 'homelab/public/' + file), true, 'homelab/public/' + file + ' must be covered by a COPY instruction');
		assert.equal(copyCovers(dockerfile.split(/\r?\n/).filter(line => !/^\s*COPY\s+homelab\s/i.test(line)).join('\n'), 'homelab/public/' + file), false, 'coverage helper must fail when the homelab COPY line is removed');
	}
});

test('server/.dockerignore keeps the setup UI bundle while the matcher rejects it for real patterns', () => {
	for (const file of setupUiFiles) {
		assert.equal(dockerignoreIgnores(dockerignore, 'homelab/public/' + file), false, 'server/.dockerignore must not exclude homelab/public/' + file);
	}

	const relative = 'homelab/public/setup.js';
	for (const pattern of ['homelab', '/homelab/', 'homelab/public', '*.js', '**/*.js', '?etup.js']) {
		assert.equal(dockerignoreIgnores(pattern, relative), true, pattern + ' must be able to ignore ' + relative);
	}
	assert.equal(dockerignoreIgnores('# comment\n\n  *.js  \n', relative), true, 'comments, blank lines and surrounding whitespace must be handled');
	assert.equal(dockerignoreIgnores('!setup.js\n*.js\n', relative), true, 'a later ignore overrides an earlier negation');
	assert.equal(dockerignoreIgnores('*.js\n!setup.js\n', relative), false, 'a final negation restores an ignored file');
	assert.equal(dockerignoreIgnores('', relative), false, 'an empty ignore file must not exclude anything');
});

test('the real setup UI bundle passes the fail-fast diagnostic', () => {
	assert.deepEqual(missingSetupUiFiles(), []);
	assert.equal(setupUiDiagnostic(), null);
	assert.equal(assertSetupUiBundle(), undefined);
});

test('an empty bundle is reported by name without leaking host details', t => {
	const directory = tempDirectory(t, 'tellybox-setup-ui-empty-');
	assert.deepEqual(missingSetupUiFiles(directory), [...setupUiFiles]);

	const diagnostic = setupUiDiagnostic(directory);
	assert.equal(typeof diagnostic, 'string');
	for (const file of setupUiFiles) assert.ok(diagnostic.includes(file), 'diagnostic must name ' + file);
	assert.ok(diagnostic.includes('homelab/public'), 'diagnostic must name the bundle directory');
	assert.equal(diagnostic.includes(directory), false, 'diagnostic must not echo the absolute directory');
	assert.equal(diagnostic.includes(path.resolve(directory)), false);
	assert.equal(diagnostic.includes(directory.replace(/\\/g, '/')), false);
	for (const marker of [os.homedir(), os.userInfo().username, 'C:\\Users', '/home/'].filter(Boolean)) {
		assert.equal(diagnostic.includes(marker), false, 'diagnostic must not echo the host marker ' + marker);
	}
	assert.doesNotMatch(diagnostic, /https?:\/\//);
	assert.doesNotMatch(diagnostic, /password|token|secret/i);

	assert.throws(() => assertSetupUiBundle(directory), error => {
		assert.equal(error.code, 'SETUP_UI_BUNDLE_MISSING');
		assert.deepEqual(error.missing, [...setupUiFiles]);
		assert.equal(error.message, diagnostic);
		return true;
	});
});

test('a partially prepared or non-file bundle lists only what is unusable', t => {
	const partial = tempDirectory(t, 'tellybox-setup-ui-partial-');
	writeFileSync(path.join(partial, 'index.html'), '<!doctype html><title>fixture</title>\n');
	assert.deepEqual(missingSetupUiFiles(partial), ['setup.js', 'setup.css', 'service-location.mjs', 'notification-mode.mjs']);
	assert.throws(() => assertSetupUiBundle(partial), error => error.code === 'SETUP_UI_BUNDLE_MISSING' && error.missing.length === 4);

	const directoryEntry = tempDirectory(t, 'tellybox-setup-ui-directory-');
	for (const file of ['index.html', 'setup.js', 'service-location.mjs', 'notification-mode.mjs']) {
		writeFileSync(path.join(directoryEntry, file), 'fixture\n');
	}
	mkdirSync(path.join(directoryEntry, 'setup.css'));
	assert.deepEqual(missingSetupUiFiles(directoryEntry), ['setup.css'], 'a directory named setup.css is not a usable bundle file');
});

test('launch fails fast on a missing bundle before creating or opening the setup listener', () => {
	const source = readFileSync(path.join(serverDirectory, 'homelab', 'launch.mjs'), 'utf8');
	assert.match(source, /import\s*\{[^}]*\bassertSetupUiBundle\b[^}]*\}\s*from\s*['"]\.\/ui-bundle\.mjs['"]/);
	const callIndex = source.search(/\bassertSetupUiBundle\s*\(\s*\)/);
	assert.ok(callIndex >= 0, 'launch.mjs must call assertSetupUiBundle()');
	assert.ok(callIndex < source.indexOf('createSetup('), 'the bundle check must run before createSetup');
	assert.ok(callIndex < source.indexOf('.listen('), 'the bundle check must run before the setup listener opens');
	assert.match(source, /process\.exit\(1\)/);
});

test('the container probe checks the real setup routes before login and after restart', () => {
	const source = readFileSync(path.join(repoRoot, 'packaging', 'check-container.mjs'), 'utf8');
	assert.match(source, /function\s+assertSetupUiServed\s*\(/);
	assert.match(source, /fetch\(base \+ '\/'\)/);
	for (const file of setupUiFiles) {
		const route = '/' + file;
		assert.ok(source.includes("'" + route + "'"), 'the container probe must request ' + route);
	}

	const calls = [...source.matchAll(/await assertSetupUiServed\(\)/g)].map(match => match.index);
	assert.ok(calls.length >= 2, 'the probe must run both before login and after restart');
	assert.ok(calls[0] < source.indexOf("request('login'"), 'the probe must run before the setup login flow');
	const restartIndex = source.indexOf("docker(['restart'");
	const recoveryIndex = source.indexOf('did not recover after restart');
	assert.ok(restartIndex >= 0 && recoveryIndex >= 0);
	assert.ok(calls[calls.length - 1] > restartIndex, 'the probe must run again after the container restart');
	assert.ok(calls[calls.length - 1] > recoveryIndex, 'the post-restart probe must follow the recovery loop');
});

test('the container probe checks the served bytes and charset, not only route titles', () => {
	const source = readFileSync(path.join(repoRoot, 'packaging', 'check-container.mjs'), 'utf8');
	assert.doesNotMatch(source, /from\s+['"]\.\/(?:encoding|version)-guard\.mjs['"]/, 'the probe ships to the public repository and must stay self-contained');
	assert.match(source, /function\s+textEncodingProblems\s*\(/, 'the probe must inspect the served bytes itself');
	assert.match(source, /charset=utf-8/i, 'the probe must require charset=utf-8 on every text response');
	assert.match(source, /textEncodingProblems\(/, 'the probe must inspect the served bytes');
	assert.match(source, /--self-test/, 'a documented negative control must exist for hosts without a container');
	for (const route of ["'/setup.js'", "'/setup.css'", "'/service-location.mjs'", "'/notification-mode.mjs'"]) {
		assert.ok(source.includes(route), 'the probe must still request ' + route);
	}
	assert.match(source, /publicBase\s*\+\s*'\/coming-soon'/, 'the probe must check one page from the server/public root as well');
});

test('the public verification workflow still builds the image and runs the container probe', () => {
	const verify = readFileSync(path.join(repoRoot, 'packaging', 'public-verify.yml'), 'utf8');
	assert.match(verify, /docker compose[^\n]*up -d --build --wait/, 'the workflow must build the fresh image');
	assert.match(verify, /node packaging\/check-container\.mjs/, 'the real setup-route probe must remain a mandatory verification step');
	const build = verify.indexOf('up -d --build --wait');
	const probe = verify.indexOf('node packaging/check-container.mjs');
	assert.ok(build >= 0 && probe > build, 'the probe must run after the image is built');
});
