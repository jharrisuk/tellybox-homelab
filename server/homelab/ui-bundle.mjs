import { statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The setup listener serves these files from homelab/public. A container image or
// build context that omits them still answers /api/setup/status, so the UI must be
// checked explicitly instead of being inferred from a healthy API.
export const setupUiFiles = Object.freeze([
	'index.html', 'setup.js', 'setup.css', 'service-location.mjs', 'notification-mode.mjs'
]);

const bundleDirectory = fileURLToPath(new URL('./public', import.meta.url));
const bundleLabel = 'homelab/public';

function isPlainFile(directory, file) {
	try { return statSync(path.resolve(directory, file)).isFile(); }
	catch { return false; }
}

export function missingSetupUiFiles(directory = bundleDirectory) {
	return setupUiFiles.filter(file => !isPlainFile(directory, file));
}

function diagnostic(missing) {
	return 'Tellybox setup UI bundle is incomplete: missing ' + missing.join(', ') + ' from ' + bundleLabel + '. '
		+ 'The container image or build context did not include the setup page. Rebuild from this source tree or restore ' + bundleLabel + '.';
}

export function setupUiDiagnostic(directory = bundleDirectory) {
	const missing = missingSetupUiFiles(directory);
	return missing.length ? diagnostic(missing) : null;
}

export function assertSetupUiBundle(directory = bundleDirectory) {
	const missing = missingSetupUiFiles(directory);
	if (!missing.length) return;
	const error = new Error(diagnostic(missing));
	error.code = 'SETUP_UI_BUNDLE_MISSING';
	error.missing = missing;
	throw error;
}
