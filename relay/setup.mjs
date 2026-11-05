#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { validateRelay, caddySite, installScript, sshArgs } from '../server/homelab/relay-core.mjs';
import { relayMediaCaddyBlock, relayMediaCaddySite, scopedCaddyScript, workerDeployment, mainWorkerControlScript, workerActivationScript } from '../server/homelab/relay-worker.mjs';
export { validateRelay, caddySite, installScript, sshArgs, relayMediaCaddyBlock, relayMediaCaddySite, scopedCaddyScript, workerDeployment, mainWorkerControlScript, workerActivationScript };
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const [command, filename, confirmation] = process.argv.slice(2);
		if (!['plan', 'check', 'install', 'site'].includes(command) || !filename) throw Error('Usage: node relay/setup.mjs plan|check|site|install private/relay.json [confirmed-hostname]');
		const c = validateRelay(JSON.parse(readFileSync(filename, 'utf8')));
		if (command === 'site') console.log(caddySite(c));
		else if (command === 'plan') console.log(`Ubuntu relay: ${c.sshUser}@${c.sshHost}:${c.sshPort}\nPublic site: ${c.hostname}\nPrivate upstream: ${c.homeTailscaleIp}:8083\nInstall Caddy and Tailscale; sign in interactively. No exit node. Existing Caddy sites are refused. DNS and firewalls stay manual. No change to the home server.\nRun check, then install with the hostname as the final argument when ready.`);
		else {
			for (const f of [c.keyFile, c.knownHostsFile]) if (!existsSync(f)) throw Error('The SSH key or pinned known-hosts file is missing.');
			if (command === 'install' && confirmation !== c.hostname) throw Error('Review the plan, then repeat install with the exact hostname as the final argument.');
			const result = spawnSync('ssh', [...sshArgs(c), command === 'check' ? 'uname -s; . /etc/os-release; printf "%s %s\\n" "$ID" "$VERSION_ID"; sudo -n true' : 'sudo -n sh -s'], { input: command === 'install' ? installScript(c) : undefined, stdio: ['pipe', 'inherit', 'inherit'], shell: false, timeout: command === 'install' ? 15 * 60000 : 30000 });
			if (result.error || result.status) process.exitCode = result.status || 1;
		}
	} catch (e) { console.error(e.message); process.exitCode = 1; }
}
