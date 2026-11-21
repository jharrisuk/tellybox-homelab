/* Release 134 P1: configuration, target and owner races around review/delete.
 *
 * Every fixture uses an injected fetch. No real qBittorrent or external network
 * is contacted and no torrent or file is changed. The assertions focus on one
 * invariant: once a review or commit has started, a disable, disconnect,
 * target/configure change, expired token or revoked owner must result in zero
 * destructive POSTs to either the reviewed target or the newly configured one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createQbittorrent, QbitError } from '../qbittorrent.mjs';

const HASH = 'a'.repeat(40);
const SESSION = 'session-fixture';
const TARGET_A = 'http://target-a.invalid';
const TARGET_B = 'http://target-b.invalid';

function row(overrides = {}) {
	return {
		hash: HASH, name: 'Fixture torrent', state: 'downloading',
		progress: 0.5, completed: 50, size: 100, total_size: 100,
		added_on: 1700000000, ...overrides
	};
}

function gate() {
	let release;
	let entered;
	const enteredPromise = new Promise(resolve => { entered = resolve; });
	const waitPromise = new Promise(resolve => { release = resolve; });
	return {
		entered: enteredPromise,
		release: () => release(),
		async wait() { entered(); await waitPromise; }
	};
}

function fixture() {
	const state = {
		deletes: [],
		logins: [],
		info: [],
		blockLogin: null,
		blockInfo: null,
		infoStatus: 200
	};
	const fetcher = async (url, options = {}) => {
		const parsed = new URL(url);
		const pathname = parsed.pathname;
		if (pathname.endsWith('/auth/login')) {
			state.logins.push(parsed.hostname);
			const block = state.blockLogin;
			if (block) { state.blockLogin = null; await block.wait(); }
			return new Response('Ok.', { headers: { 'set-cookie': 'SID=' + parsed.hostname } });
		}
		if (pathname.endsWith('/app/webapiVersion')) return new Response('2.11.2');
		if (pathname.endsWith('/app/version')) return new Response('5.0.3');
		if (pathname.endsWith('/torrents/categories')) return new Response('{}');
		if (pathname.endsWith('/transfer/info')) return new Response('{}');
		if (pathname.endsWith('/torrents/info')) {
			state.info.push({ target: parsed.hostname, hashes: parsed.searchParams.get('hashes') });
			const block = state.blockInfo;
			if (block) { state.blockInfo = null; await block.wait(); }
			if (state.infoStatus !== 200) return new Response('', { status: state.infoStatus });
			return new Response(JSON.stringify([row()]));
		}
		if (pathname.endsWith('/torrents/delete')) {
			state.deletes.push({ target: parsed.hostname, body: options.body });
			return new Response('');
		}
		return new Response('{}');
	};
	return { state, fetcher };
}

function setup(t, overrides = {}) {
	const directory = mkdtempSync(path.join(tmpdir(), 'tellybox-qb134-race-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const file = path.join(directory, 'qbittorrent.json');
	writeFileSync(file, JSON.stringify({
		url: TARGET_A, username: 'owner', password: 'fixture-password',
		enabled: true, pollSeconds: 15, stalledMinutes: 30, ...overrides
	}));
	return { directory, file };
}

function rewriteConfig(file, overrides = {}) {
	writeFileSync(file, JSON.stringify({
		url: TARGET_A, username: 'owner', password: 'fixture-password',
		enabled: true, pollSeconds: 15, stalledMinutes: 30, ...overrides
	}));
}

async function primed(qb) {
	const listing = await qb.list();
	assert.equal(listing.state, 'ok');
	return listing.rows[0].id;
}

async function reviewed(qb, id, action = 'remove') {
	const review = await qb.confirmation({ id, action, sessionToken: SESSION });
	assert.match(review.token, /^[a-f0-9]{64}$/);
	return review;
}

function zeroDeletes(state) {
	assert.deepEqual(state.deletes, [], 'no destructive POST may reach any target');
}

test('disable to a different target during the commit lookup refuses with zero deletes', async t => {
	const { file } = setup(t);
	const { state, fetcher } = fixture();
	const qb = createQbittorrent({ file, fetcher });
	const id = await primed(qb);
	const review = await reviewed(qb, id);

	const blocked = gate();
	state.blockInfo = blocked;
	const pending = qb.commit({ token: review.token, sessionToken: SESSION });
	await blocked.entered;
	// The PRIMARY reproduction: a new disabled target is saved while the
	// commit's fresh torrent lookup is suspended.
	await qb.configure({ url: TARGET_B, enabled: false });
	blocked.release();

	const result = await pending;
	assert.equal(result.ok, false);
	assert.equal(result.outcome, 'source-changed');
	assert.equal(result.status, 409);
	assert.equal(result.needsRecheck, true);
	assert.equal(qb.status().enabled, false);
	zeroDeletes(state);
});

test('disconnect during the commit lookup refuses with zero deletes', async t => {
	const { file } = setup(t);
	const { state, fetcher } = fixture();
	const qb = createQbittorrent({ file, fetcher });
	const id = await primed(qb);
	const review = await reviewed(qb, id);

	const blocked = gate();
	state.blockInfo = blocked;
	const pending = qb.commit({ token: review.token, sessionToken: SESSION });
	await blocked.entered;
	qb.disconnect();
	blocked.release();

	const result = await pending;
	assert.equal(result.ok, false);
	assert.equal(result.outcome, 'source-changed');
	assert.equal(qb.status().configured, false);
	zeroDeletes(state);
});

test('switching to another enabled target during the commit lookup never posts to either target', async t => {
	const { file } = setup(t);
	const { state, fetcher } = fixture();
	const qb = createQbittorrent({ file, fetcher });
	const id = await primed(qb);
	const review = await reviewed(qb, id);

	const blocked = gate();
	state.blockInfo = blocked;
	const pending = qb.commit({ token: review.token, sessionToken: SESSION });
	await blocked.entered;
	await qb.configure({ url: TARGET_B, enabled: true });
	blocked.release();

	const result = await pending;
	assert.equal(result.ok, false);
	assert.equal(result.outcome, 'source-changed');
	assert.equal(qb.status().enabled, true);
	assert.ok(state.logins.includes('target-b.invalid'), 'the new target was configured');
	zeroDeletes(state);
});

test('an out-of-band disable during the commit lookup is caught by the final enabled check', async t => {
	const { file } = setup(t);
	const { state, fetcher } = fixture();
	const qb = createQbittorrent({ file, fetcher });
	const id = await primed(qb);
	const review = await reviewed(qb, id);

	const blocked = gate();
	state.blockInfo = blocked;
	const pending = qb.commit({ token: review.token, sessionToken: SESSION });
	await blocked.entered;
	// Same generation and target, but disabled on disk. Only an immediate
	// enabled check can catch this.
	rewriteConfig(file, { enabled: false });
	blocked.release();

	const result = await pending;
	assert.equal(result.ok, false);
	assert.equal(result.outcome, 'source-changed');
	assert.equal(qb.status().enabled, false);
	zeroDeletes(state);
});

test('an out-of-band target switch during the commit lookup is caught by the captured target check', async t => {
	const { file } = setup(t);
	const { state, fetcher } = fixture();
	const qb = createQbittorrent({ file, fetcher });
	const id = await primed(qb);
	const review = await reviewed(qb, id);

	const blocked = gate();
	state.blockInfo = blocked;
	const pending = qb.commit({ token: review.token, sessionToken: SESSION });
	await blocked.entered;
	rewriteConfig(file, { url: TARGET_B });
	blocked.release();

	const result = await pending;
	assert.equal(result.ok, false);
	assert.equal(result.outcome, 'source-changed');
	zeroDeletes(state);
});

test('disable during the destructive login refuses with zero deletes', async t => {
	const { file } = setup(t);
	const { state, fetcher } = fixture();
	const qb = createQbittorrent({ file, fetcher });
	const id = await primed(qb);
	const review = await reviewed(qb, id);

	const blocked = gate();
	state.blockLogin = blocked;
	const pending = qb.commit({ token: review.token, sessionToken: SESSION });
	await blocked.entered;
	await qb.configure({ enabled: false });
	blocked.release();

	const result = await pending;
	assert.equal(result.ok, false);
	assert.equal(result.outcome, 'source-changed');
	assert.equal(qb.status().enabled, false);
	zeroDeletes(state);
});

test('a confirmation that expires during its lookup cannot delete', async t => {
	const { file } = setup(t);
	const { state, fetcher } = fixture();
	let now = 1800000000000;
	const qb = createQbittorrent({ file, fetcher, clock: () => now });
	const id = await primed(qb);
	const review = await reviewed(qb, id);

	const blocked = gate();
	state.blockInfo = blocked;
	const pending = qb.commit({ token: review.token, sessionToken: SESSION });
	await blocked.entered;
	now += 61000;
	blocked.release();

	await assert.rejects(pending, error => error instanceof QbitError && error.code === 'replay');
	zeroDeletes(state);
});

test('an upstream session expiry during the commit lookup is not retried and cannot delete', async t => {
	const { file } = setup(t);
	const { state, fetcher } = fixture();
	const qb = createQbittorrent({ file, fetcher });
	const id = await primed(qb);
	const review = await reviewed(qb, id);

	const infoBefore = state.info.length;
	state.infoStatus = 401;
	await assert.rejects(
		qb.commit({ token: review.token, sessionToken: SESSION }),
		error => error instanceof QbitError && error.code === 'auth-failed'
	);
	assert.equal(state.info.length, infoBefore + 1, 'the lookup is attempted once, not retried');
	zeroDeletes(state);
});

test('owner revocation after the commit lookup refuses before any destructive request', async t => {
	const { file } = setup(t);
	const { state, fetcher } = fixture();
	const qb = createQbittorrent({ file, fetcher });
	const id = await primed(qb);
	const review = await reviewed(qb, id);

	let ownerChecks = 0;
	await assert.rejects(
		qb.commit({
			token: review.token, sessionToken: SESSION,
			verifyOwner: async () => { ownerChecks += 1; return false; }
		}),
		error => error instanceof QbitError && error.code === 'owner-required' && error.status === 401
	);
	assert.equal(ownerChecks, 1, 'the first post-lookup owner check failed closed');
	zeroDeletes(state);
});

test('owner revocation during the destructive login is rechecked before transmission', async t => {
	const { file } = setup(t);
	const { state, fetcher } = fixture();
	const qb = createQbittorrent({ file, fetcher });
	const id = await primed(qb);
	const review = await reviewed(qb, id);

	let ownerChecks = 0;
	const blocked = gate();
	state.blockLogin = blocked;
	const pending = qb.commit({
		token: review.token, sessionToken: SESSION,
		// The first check passes; the second runs after the awaited login.
		verifyOwner: async () => { ownerChecks += 1; return ownerChecks === 1; }
	});
	await blocked.entered;
	blocked.release();

	await assert.rejects(pending, error => error instanceof QbitError && error.code === 'owner-required');
	assert.equal(ownerChecks, 2);
	zeroDeletes(state);
});

test('a target switch during the confirmation lookup refuses to issue a token', async t => {
	const { file } = setup(t);
	const { state, fetcher } = fixture();
	const qb = createQbittorrent({ file, fetcher });
	const id = await primed(qb);

	const blocked = gate();
	state.blockInfo = blocked;
	const pending = qb.confirmation({ id, action: 'remove', sessionToken: SESSION });
	await blocked.entered;
	await qb.configure({ url: TARGET_B, enabled: true });
	blocked.release();

	await assert.rejects(pending, error => error instanceof QbitError && error.code === 'source-changed');
	assert.equal(qb.status().enabled, true);
	zeroDeletes(state);
});

test('owner revocation during the confirmation lookup refuses to issue a token', async t => {
	const { file } = setup(t);
	const { state, fetcher } = fixture();
	const qb = createQbittorrent({ file, fetcher });
	const id = await primed(qb);

	const blocked = gate();
	state.blockInfo = blocked;
	const pending = qb.confirmation({
		id, action: 'delete-files', sessionToken: SESSION,
		verifyOwner: async () => false
	});
	await blocked.entered;
	blocked.release();

	await assert.rejects(pending, error => error instanceof QbitError && error.code === 'owner-required');
	zeroDeletes(state);
});

test('configure does not persist after its awaited login when the owner was revoked', async t => {
	const { file } = setup(t);
	const { state, fetcher } = fixture();
	const qb = createQbittorrent({ file, fetcher });

	const blocked = gate();
	state.blockLogin = blocked;
	const pending = qb.configure(
		{ url: TARGET_B, enabled: true },
		{ verifyOwner: async () => false }
	);
	await blocked.entered;
	blocked.release();

	await assert.rejects(pending, error => error instanceof QbitError && error.code === 'owner-required');
	const saved = JSON.parse(readFileSync(file, 'utf8'));
	assert.equal(saved.url, TARGET_A, 'the revoked configure request did not replace the saved target');
	assert.equal(saved.enabled, true);
	assert.equal(saved.password, 'fixture-password');
	zeroDeletes(state);
});

test('an older configure completion cannot restore stale config or SID after a newer configure', async t => {
	const { file } = setup(t);
	const { state, fetcher } = fixture();
	const qb = createQbittorrent({ file, fetcher });

	const blocked = gate();
	state.blockLogin = blocked;
	const older = qb.configure({ url: TARGET_B, enabled: true });
	await blocked.entered;
	const newer = await qb.configure({ url: TARGET_A, enabled: true });
	const newerGeneration = newer.generation;
	blocked.release();

	await assert.rejects(older, error => error instanceof QbitError && error.code === 'source-changed');
	const saved = JSON.parse(readFileSync(file, 'utf8'));
	assert.equal(saved.url, TARGET_A, 'the newer configuration remains authoritative');
	assert.equal(qb.status().generation, newerGeneration, 'the stale completion did not bump the generation');

	await qb.list();
	assert.equal(state.info.at(-1).target, 'target-a.invalid', 'the stale login did not restore a SID for the old target');
	zeroDeletes(state);
});

test('disconnect invalidates a configure that is awaiting its login', async t => {
	const { file } = setup(t);
	const { state, fetcher } = fixture();
	const qb = createQbittorrent({ file, fetcher });

	const blocked = gate();
	state.blockLogin = blocked;
	const pending = qb.configure({ url: TARGET_B, enabled: true });
	await blocked.entered;
	qb.disconnect();
	blocked.release();

	await assert.rejects(pending, error => error instanceof QbitError && error.code === 'source-changed');
	assert.equal(qb.status().configured, false);
	zeroDeletes(state);
});

test('a stale list login cannot install a SID after the integration is disabled', async t => {
	const { file } = setup(t);
	const { state, fetcher } = fixture();
	const qb = createQbittorrent({ file, fetcher });

	const blocked = gate();
	state.blockLogin = blocked;
	const pending = qb.list();
	await blocked.entered;
	await qb.configure({ enabled: false });
	blocked.release();

	const stale = await pending;
	assert.equal(stale.state, 'source-changed');
	const infoBefore = state.info.length;
	const disabled = await qb.list();
	assert.equal(disabled.state, 'disabled');
	assert.equal(state.info.length, infoBefore, 'no upstream request is made while disabled');
	zeroDeletes(state);
});
