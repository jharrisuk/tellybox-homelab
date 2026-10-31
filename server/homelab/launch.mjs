import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSetup } from './admin.mjs';
import { createApplyController } from './apply.mjs';

const directory = path.resolve(process.env.HOMELAB_DATA || './private');
let child, stopping = false;
const status = () => ({ running: Boolean(child && child.exitCode === null && child.signalCode === null), ...controller.status() });
async function stop() {
	if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) return;
	const current = child, exited = once(current, 'exit'); current.kill('SIGTERM');
	const timer = setTimeout(() => current.kill('SIGKILL'), 5000);
	await exited; clearTimeout(timer);
}
const controller = createApplyController({ directory, stop,
	start: async environment => {
		const instance = randomUUID();
		const env = { ...process.env, ...environment, HOMELAB_INSTANCE: instance };
		child = spawn(process.execPath, ['server.mjs'], { cwd: path.dirname(fileURLToPath(new URL('../server.mjs', import.meta.url))), env, stdio: ['ignore', 'inherit', 'inherit'] });
		child.on('error', () => console.error('Media process could not start. Setup remains available.'));
		child.on('exit', () => { if (!controller.status().applying && !stopping) console.error('Media process stopped. Check setup and apply again.'); });
		return { process: child, instance };
	},
	ready: async ({ process: current, instance }) => {
		// Readiness requires a real response from this child, not an optimistic spawn result.
		for (let i = 0; i < 60; i++) {
			await new Promise(resolve => setTimeout(resolve, 200));
			if (!current.pid || current.exitCode !== null || current.signalCode !== null) throw Error('Media process exited.');
			try { const r = await fetch(`http://127.0.0.1:${process.env.PORT || 8082}/homelab-ready`, { signal: AbortSignal.timeout(500) }); if (r.ok && (await r.json()).instance === instance) return; } catch {}
		}
		throw Error('Media process did not become ready.');
	}
});
const setup = createSetup({ directory, apply: controller.apply, status, allowedHosts:process.env.SETUP_ALLOWED_HOSTS || '' });
const listener = setup.app.listen(Number(process.env.SETUP_PORT || 8990), process.env.SETUP_BIND || '127.0.0.1', () => console.log('Tellybox setup is available on the configured private binding, port ' + (process.env.SETUP_PORT || 8990) + '. First setup code: bootstrap.json in the configuration directory (read locally; do not publish).'));
await controller.boot().catch(() => console.error('Media is not ready. Use the setup page to configure this installation.'));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { stopping = true; await stop(); listener.close(); process.exit(0); });
