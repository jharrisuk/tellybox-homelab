import path from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from 'node:fs';
import { createPrivateKey, createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { validateRelay, caddySite, installScript, sshArgs } from './relay-core.mjs';
import { workerPreflightScript, parseWorkerPreflight } from './relay-worker.mjs';
import { atomicJson } from './config.mjs';

const fail = (message, status = 400) => Object.assign(Error(message), { status });
export function relayManager(directory, { runner = spawn, clock = Date.now } = {}) {
	const root = path.join(directory, 'relay'), configFile = path.join(root, 'connection.json'), preflightFile = path.join(root, 'worker-preflight.json');
	let job = null, process = null, checked = '', detectedTailscaleIp = '';
	const config = () => existsSync(configFile) ? JSON.parse(readFileSync(configFile, 'utf8')) : null;
	const preflight = () => { try { return JSON.parse(readFileSync(preflightFile, 'utf8')); } catch { return null; } };
	const identity = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
	function status() {
		const c = config();
		return { connection: c ? { hostname: c.hostname, sshHost: c.sshHost, sshPort: c.sshPort, sshUser: c.sshUser, homeTailscaleIp: c.homeTailscaleIp,
			relayTailscaleIp: c.relayTailscaleIp || detectedTailscaleIp, credentialsSaved: true } : null,
			workerPreflight: preflight(), checked: Boolean(c && checked === identity(c)), job: job ? { ...job } : null };
	}
	function save(input) {
		if (process) throw fail('Wait for the current relay task to finish.', 409);
		const old = config(), c = validateRelay({ hostname: input.hostname, sshHost: input.sshHost, sshPort: input.sshPort, sshUser: input.sshUser, homeTailscaleIp: input.homeTailscaleIp,
			relayTailscaleIp: input.relayTailscaleIp || old?.relayTailscaleIp || detectedTailscaleIp || '',
			keyFile: path.join(root, 'ssh-key'), knownHostsFile: path.join(root, 'known-hosts') });
		const changedHost = old && (old.sshHost !== c.sshHost || old.sshPort !== c.sshPort);
		if (!old && !input.privateKey || changedHost && !input.knownHosts) throw fail('Add the SSH key and verified known-hosts entry for this server.');
		if (input.privateKey) {
			if (typeof input.privateKey !== 'string' || input.privateKey.length > 16000 || !/^-----BEGIN (?:OPENSSH |RSA |EC )?PRIVATE KEY-----/.test(input.privateKey)) throw fail('Choose a private SSH key file, not its .pub file.');
			// OpenSSH validates its native format when connecting; reject PEM keys requiring a passphrase here.
			if (!input.privateKey.startsWith('-----BEGIN OPENSSH')) try { createPrivateKey(input.privateKey); } catch { throw fail('Use a valid, dedicated SSH key without a passphrase for this unattended helper.'); }
		}
		if (typeof input.knownHosts !== 'string' || input.knownHosts.length > 16000 || /[\x00-\x08]/.test(input.knownHosts)) throw fail('Paste the verified known-hosts entry.');
		if (input.knownHosts && !/\s(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp\d+) [A-Za-z0-9+/=]+/.test(input.knownHosts)) throw fail('Use an OpenSSH known-hosts entry after verifying its fingerprint through the server console.');
		if ((!old || changedHost) && !input.knownHosts) throw fail('A pinned host key is required.');
		mkdirSync(root, { recursive: true, mode: 0o700 });
		for (const [field, file] of [['privateKey', c.keyFile], ['knownHosts', c.knownHostsFile]]) if (input[field]) {
			writeFileSync(file, input[field].replace(/\r/g, '').trimEnd() + '\n', { mode: 0o600 }); chmodSync(file, 0o600);
		}
		atomicJson(configFile, c); checked = ''; job = null;
		if (old && (changedHost || old.relayTailscaleIp !== c.relayTailscaleIp)) rmSync(preflightFile, { force: true });
		return status();
	}
	function plan() {
		const c = config(); if (!c) throw fail('Save the relay connection first.');
		return { hostname: c.hostname, target: `${c.sshUser}@${c.sshHost}:${c.sshPort}`, upstream: `${c.homeTailscaleIp}:8083`, site: caddySite(c),
			steps: ['Check Ubuntu 24.04 and passwordless sudo.', 'Refuse an existing Caddy installation unless this helper created it.', 'Install Caddy and Tailscale. Approve your own Tailscale sign-in link.', 'Check the private connection to your home server.', 'Validate and reload the new HTTPS route with rollback on failure.', 'Optionally prepare dormant private worker connectivity without opening an endpoint.'],
			manual: ['DNS and firewall ports 80/443.', 'Trust the relay’s exact Tailscale IP in Tellybox.', 'Keep SSH available until you have tested private management.', 'A Tailscale account may need to approve the relay node and allow main-to-relay tailnet traffic. This helper never edits ACLs or other nodes.'] };
	}
	function start(action, confirmation) {
		if (process) throw fail('A relay task is already running.', 409);
		if (!['check', 'install', 'prepare-worker'].includes(action)) throw fail('Choose Check, Prepare private connectivity or Install.');
		const c = config(); if (!c) throw fail('Save the relay connection first.');
		if (action === 'install' && (checked !== identity(c) || confirmation !== c.hostname)) throw fail('Check the saved connection, review the plan, then confirm its exact hostname.');
		job = { id: randomUUID(), action, status: 'running', started: clock(), output: '', exitCode: null };
		const current = job;
		const append = chunk => { current.output = (current.output + String(chunk).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')).slice(-60000); };
		const command = action === 'check' ? 'set -eu; . /etc/os-release; test "$ID" = ubuntu; test "$VERSION_ID" = 24.04; sudo -n true; printf "Ubuntu 24.04 and sudo ready\\n"; tailscale ip -4 2>/dev/null || true'
			: action === 'prepare-worker' ? workerPreflightScript({ homeTailscaleIp: c.homeTailscaleIp })
				: 'sudo -n sh -s';
		try { process = runner('ssh', [...sshArgs(c), command], { shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); }
		catch { current.status = 'failed'; throw fail('Could not start SSH. Install the OpenSSH client on this host.'); }
		const child = process, timer = setTimeout(() => { append('\nTask timed out. Review the server before retrying.\n'); child.kill(); }, action === 'install' ? 15 * 60000 : 30000);
		timer.unref?.(); child.stdout.on('data', append); child.stderr.on('data', append);
		child.on('error', () => { append('\nSSH could not start.\n'); });
		child.on('close', code => {
			clearTimeout(timer); process = null; current.exitCode = code; current.finished = clock();
			current.status = code === 0 ? 'succeeded' : action === 'install' && code === 2 ? 'approval-needed' : 'failed';
			if (action === 'check') {
				checked = code === 0 ? identity(c) : '';
				const found = code === 0 && /(?:^|\s)(100\.\d+\.\d+\.\d+)(?:\s|$)/.exec(current.output)?.[1];
				if (found) { detectedTailscaleIp = found; if (c.relayTailscaleIp !== found) { c.relayTailscaleIp = found; atomicJson(configFile, c); checked = identity(c); } }
			}
			if (action === 'prepare-worker' && code === 0) {
				try {
					const result = parseWorkerPreflight(current.output);
					atomicJson(preflightFile, { ...result, preparedAt: clock(), source: 'tailscale-preflight' });
					if (result.ip && c.relayTailscaleIp !== result.ip) { c.relayTailscaleIp = result.ip; atomicJson(configFile, c); }
				} catch (error) { current.status = 'failed'; append('\nPreflight result could not be read: ' + error.message + '\n'); }
			}
		});
		child.stdin.on('error', () => {}); child.stdin.end(action === 'install' ? installScript(c) : undefined);
		return status();
	}
	return { status, save, plan, start };
}
