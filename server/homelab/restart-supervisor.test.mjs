import test from 'node:test';
import assert from 'node:assert/strict';
import { createRestartSupervisor } from './restart-supervisor.mjs';

function harness({ restart = async () => {}, applying = false, running = true } = {}) {
	const timers = [], logs = [];
	let now = 0, sequence = 0;
	const status = () => ({ applying, running });
	const supervisor = createRestartSupervisor({
		restart, status, timers: {
			setTimeout(fn, ms) { const timer = { fn, ms, due: now + ms, seq: sequence++, cleared: false }; timers.push(timer); return timer; },
			clearTimeout(timer) { timer.cleared = true; }
		},
		log: { log() {}, error: message => logs.push(message) }
	});
	const pending = () => timers.filter(timer => !timer.cleared);
	const fire = async () => {
		const timer = pending().at(-1);
		assert.ok(timer, 'a timer is pending');
		timer.cleared = true;
		await timer.fn();
		return timer;
	};
	const advance = async ms => {
		const target = now + ms;
		for (;;) {
			const next = pending().filter(timer => timer.due <= target)
				.sort((left, right) => left.due - right.due || left.seq - right.seq)[0];
			if (!next) break;
			now = next.due;
			next.cleared = true;
			await next.fn();
		}
		now = target;
	};
	return { supervisor, timers, logs, pending, fire, advance, get now() { return now; } };
}

test('unexpected exits use the bounded delay list and a stable period resets it', async () => {
	let restarts = 0;
	const h = harness({ restart: async () => { restarts++; } });
	assert.equal(h.supervisor.schedule(), true);
	assert.equal(h.supervisor.schedule(), false, 'a second exit cannot duplicate the timer');
	assert.equal(h.pending()[0].ms, 2000);
	assert.equal(h.supervisor.state().attempts, 1);
	await h.fire();
	assert.equal(restarts, 1);
	const settle = h.pending().at(-1);
	assert.equal(settle.ms, 60000);
	settle.cleared = true; settle.fn();
	assert.equal(h.supervisor.state().attempts, 0, 'a stable child earns a fresh budget');
});

test('an old stability timer cannot reset the budget after a later short-lived child', async () => {
	let restarts = 0;
	const h = harness({ restart: async () => { restarts++; if (restarts > 1) throw Error('not ready'); } });
	assert.equal(h.supervisor.schedule(), true, 'first unexpected exit');
	await h.advance(2000);
	assert.equal(h.supervisor.state().attempts, 1);
	assert.equal(h.supervisor.state().settlePending, true, 'first child starts its stability window');

	await h.advance(28000);
	h.supervisor.schedule();
	await h.advance(5000);
	assert.equal(h.supervisor.state().attempts, 3);
	await h.advance(15000);
	assert.equal(h.supervisor.state().attempts, 4);

	// The first child's stability deadline is 62 seconds. Later short-lived
	// children must invalidate it, or it fires here and resets the budget while
	// the fourth recovery is still pending.
	await h.advance(12000);
	assert.equal(h.supervisor.state().attempts, 4, 'an old stability deadline must not reset the budget');
	assert.equal(h.supervisor.state().settlePending, false);

	await h.advance(18000);
	assert.equal(h.supervisor.state().attempts, 5);
	assert.equal(h.pending()[0].ms, 60000, 'the fifth attempt keeps the 60-second backoff');
	await h.advance(60000);
	assert.equal(h.supervisor.state().attempts, 5, 'the fifth failure exhausts the bounded budget');
	assert.equal(h.supervisor.state().pending, false, 'recovery pauses instead of restarting again');
	assert.equal(restarts, 5);
	h.supervisor.dispose();
});

test('cancel and deliberate startup clear a pending stability reset', async () => {
	const h = harness();
	assert.equal(h.supervisor.schedule(), true);
	await h.advance(2000);
	assert.equal(h.supervisor.state().attempts, 1);
	assert.equal(h.supervisor.state().settlePending, true);
	h.supervisor.cancel();
	assert.equal(h.supervisor.state().settlePending, false, 'cancel clears continuous-health tracking');
	await h.advance(70000);
	assert.equal(h.supervisor.state().attempts, 1, 'a cancelled child cannot reset the budget later');

	h.supervisor.startup();
	assert.equal(h.supervisor.state().attempts, 0, 'a deliberate start resets the budget');
	await h.advance(70000);
	assert.equal(h.supervisor.state().attempts, 0);
	h.supervisor.dispose();
});

test('failed restarts advance the backoff and then pause instead of storming', async () => {
	let restarts = 0;
	const h = harness({ restart: async () => { restarts++; throw Error('not ready'); } });
	assert.equal(h.supervisor.schedule(), true);
	await h.fire();
	assert.equal(restarts, 1);
	assert.equal(h.pending().at(-1).ms, 5000, 'retry uses the next delay');
	await h.fire();
	assert.equal(h.pending().at(-1).ms, 15000);
	await h.fire();
	assert.equal(h.pending().at(-1).ms, 30000);
	await h.fire();
	assert.equal(h.pending().at(-1).ms, 60000);
	await h.fire();
	assert.equal(restarts, 5);
	assert.equal(h.supervisor.schedule(), false, 'sixth automatic restart is refused');
	assert.equal(h.supervisor.state().attempts, 5);
	assert.match(h.logs.at(-1), /automatic recovery is paused/);
});

test('deliberate apply, shutdown and cancel never schedule a child', async () => {
	let restarts = 0;
	const applying = harness({ applying: true, restart: async () => { restarts++; } });
	assert.equal(applying.supervisor.schedule(), false, 'apply owns the lifecycle');
	applying.supervisor.dispose();

	const h = harness({ restart: async () => { restarts++; } });
	assert.equal(h.supervisor.schedule(), true);
	h.supervisor.cancel();
	assert.equal(h.pending().length, 0, 'deliberate stop clears the pending retry');
	assert.equal(h.supervisor.schedule(), true);
	const stale = h.pending()[0];
	h.supervisor.dispose();
	assert.equal(h.supervisor.schedule(), false, 'shutdown never restarts');
	await stale.fn();
	assert.equal(restarts, 0, 'a disposed supervisor ignores its stale timer');
});

test('a child that exits after recovery is not accepted as healthy', async () => {
	let restarts = 0;
	const h = harness({ running: false, restart: async () => { restarts++; } });
	assert.equal(h.supervisor.schedule(), true);
	await h.fire();
	assert.equal(restarts, 1);
	assert.equal(h.supervisor.state().attempts, 2, 'the next bounded attempt is scheduled');
	assert.equal(h.pending().at(-1).ms, 5000);
	h.supervisor.dispose();
});

test('an exit during recovery schedules another bounded attempt', async () => {
	let release, restarts = 0;
	const gate = new Promise(resolve => { release = resolve; });
	const h = harness({ restart: async () => { restarts++; await gate; } });
	assert.equal(h.supervisor.schedule(), true);
	const firing = h.fire();
	assert.equal(h.supervisor.schedule(), false, 'a second schedule cannot duplicate the child');
	release();
	await firing;
	assert.equal(restarts, 1);
	assert.equal(h.supervisor.state().attempts, 2, 'the exit observed during recovery is retried');
	assert.equal(h.pending().at(-1).ms, 5000);
	h.supervisor.dispose();
});

test('a deliberate startup clears a stale budget but a recovery start keeps it', async () => {
	let restarts = 0;
	const h = harness({ restart: async () => { restarts++; throw Error('down'); } });
	h.supervisor.schedule();
	await h.fire();
	assert.equal(h.supervisor.state().attempts, 2, 'first fire plus retry attempt');
	h.supervisor.startup();
	assert.equal(h.supervisor.state().attempts, 0);
	assert.equal(h.supervisor.state().pending, false);
	h.supervisor.dispose();
});
