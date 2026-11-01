import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

// One shared allowance for every remote media response, not one limit per viewer.
export function createUploadLimit(directory, {clock=Date.now,now=()=>performance.now(),setTimer=setTimeout,clearTimer=clearTimeout}={}) {
	const file = path.join(directory, 'upload-limit.json');
	let mbps = 50, schedule=[];
	try { const saved=JSON.parse(readFileSync(file,'utf8'));mbps=saved.mbps;schedule=saved.schedule||[]; }
	catch (error) { if (error.code !== 'ENOENT') throw error; }
	function validate(value) {
		if (!Number.isInteger(value) || value < 0 || value > 1000) {
			throw Object.assign(new Error('Enter a whole number from 1 to 1000 Mbps, or 0 for unlimited.'), { status: 400 });
		}
	}
	validate(mbps);
	function validateSchedule(value){
		if(!Array.isArray(value)||value.length>12)throw Object.assign(Error('Use up to 12 time periods.'),{status:400});
		const occupied=new Set();
		return value.map(row=>{
			if(!row||!/^([01]\d|2[0-3]):[0-5]\d$/.test(row.start)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(row.end)||row.start===row.end)throw Object.assign(Error('Choose different start and end times.'),{status:400});
			validate(row.mbps);const from=minutes(row.start),to=minutes(row.end);
			for(let minute=from;minute!==to;minute=(minute+1)%1440){if(occupied.has(minute))throw Object.assign(Error('Upload periods must not overlap.'),{status:400});occupied.add(minute);}
			return {start:row.start,end:row.end,mbps:row.mbps};
		});
	}
	function minutes(time){const [h,m]=time.split(':').map(Number);return h*60+m;}
	const formatter=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/London',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
	let cachedMinute=-1,cachedClock=0;
	function effective(){const instant=clock(),minute=Math.floor(instant/60000);if(minute!==cachedMinute){cachedMinute=minute;cachedClock=minutes(formatter.format(instant));}const now=cachedClock;
		return schedule.find(row=>{const a=minutes(row.start),b=minutes(row.end);return a<b?now>=a&&now<b:now>=a||now<b;})?.mbps??mbps;
	}
	schedule=validateSchedule(schedule);let rate=effective();
	const quantum = 16 * 1024;
	const burst = 64 * 1024;
	let tokens = burst;
	let updated = now();
	let timer;
	let waited = '';
	let transferredBytes = 0;
	const queue = [];
	const active = new Map();
	// Weighted fair queuing by account. Weight is divided between an account's
	// concurrent streams so three devices do not get three times one viewer.
	const accounts = new Map();
	const samples = new Map();
	const windowMs = 10000;
	function measured(owner, at = now()) {
		let bytes = 0;
		for (const [key, buckets] of samples) {
			for (const [second, count] of buckets) {
				if (second * 1000 <= at - windowMs) buckets.delete(second);
				else if (owner === undefined || owner === key) bytes += count;
			}
			if (!buckets.size) samples.delete(key);
		}
		return Math.round(bytes * 8 / windowMs / 1000 * 100) / 100;
	}
	function accountState(account) {
		let state = accounts.get(account);
		if (!state) { state = { streams: 0, weight: 1, deficit: 0, priorities: new Map() }; accounts.set(account, state); }
		return state;
	}
	function refreshPriority(state) {
		let weight = 1;
		for (const value of state.priorities.values()) if (value > weight) weight = value;
		// Losing a high-priority stream must not leave its credit behind for the
		// ordinary streams that are still open on the same account.
		if (weight !== state.weight) { state.weight = weight; state.deficit = 0; }
	}
	// Deficit weighted round robin. Each account earns weight-proportional credit
	// per round, so a high-priority account transfers more bytes without ever
	// replacing an ordinary account's queue slot or exceeding the global cap.
	function eligibleRequest() {
		if (!queue.length) return null;
		return queue.find(request => accountState(request.account).deficit >= request.bytes) || null;
	}
	function waitingAccount() {
		for (const [account, state] of accounts) {
			if (state.streams > 0 && state.deficit > 0 && !queue.some(request => request.account === account)) return account;
		}
		return '';
	}
	function refill() {
		const at=now();rate=effective();
		tokens = Math.min(burst, tokens + (at - updated) * rate * 125);
		updated = at;
	}
	function drain() {
		clearTimer(timer); timer = null;
		refill();
		if (waited && queue.some(request => request.account === waited)) waited = '';
		while (queue.length) {
			// Weighted by account, first-arrived first within equal credit. Idle
			// registered devices never enter this queue.
			let request = eligibleRequest();
			if (!request) {
				const waiting = waitingAccount();
				if (waiting && waited !== waiting) {
					waited = waiting;
					timer = setTimer(drain, 0);
					return;
				}
				for (const account of new Set(queue.map(item => item.account))) accountState(account).deficit += accountState(account).weight * quantum;
				request = eligibleRequest() || queue[0];
			}
			if (rate && tokens < request.bytes) {
				timer = setTimer(drain, Math.max(1, Math.ceil((request.bytes - tokens) / (rate * 125))));
				return;
			}
			queue.splice(queue.indexOf(request), 1);
			const state = accountState(request.account);
			state.deficit -= request.bytes;
			if (rate) tokens -= request.bytes;
			request.signal?.removeEventListener('abort', request.abort);
			transferredBytes += request.bytes;
			const second = Math.floor(now() / 1000);
			if (!samples.has(request.owner)) samples.set(request.owner, new Map());
			const buckets = samples.get(request.owner);
			buckets.set(second, (buckets.get(second) || 0) + request.bytes);
			// Bound storage even if nobody opens diagnostics.
			if (buckets.size > 11 || samples.size > 100) measured();
			request.resolve();
		}
	}
	function take(bytes, signal, owner, account) {
		return new Promise((resolve, reject) => {
			const request = { bytes, resolve, signal, owner, account, abort: () => {
				const index = queue.indexOf(request);
				if (index >= 0) queue.splice(index, 1);
				signal?.removeEventListener('abort', request.abort);
				reject(signal?.reason || new Error('Transfer cancelled.'));
				drain();
			} };
			if (signal?.aborted) return request.abort();
			signal?.addEventListener('abort', request.abort, { once: true });
			queue.push(request);
			drain();
		});
	}
	return {
		measuredMbps: owner => measured(owner),
		status: () => ({ mbps:effective(), defaultMbps:mbps,schedule,timezone:'Europe/London', measuredMbps: measured(), measurementSeconds: windowMs / 1000, transferredBytes, activeTransfers: active.size, estimatedMbpsPerTransfer: active.size && effective() ? effective() / active.size : null }),
		set(value,periods=schedule) {
			validate(value);
			const next=validateSchedule(periods);
			mkdirSync(directory, { recursive: true, mode: 0o700 });
			writeFileSync(file + '.tmp', JSON.stringify({ mbps: value,schedule:next }), { mode: 0o600 });
			renameSync(file + '.tmp', file);
			refill();
			mbps = value;schedule=next;
			drain();
			return { mbps:effective(),defaultMbps:mbps,schedule,timezone:'Europe/London' };
		},
		async *stream(source, signal, owner = Symbol('transfer'), {account = owner, weight = 1} = {}) {
			const state = accountState(account);
			const configured = Number(weight);
			const streamId = Symbol('priority');
			state.priorities.set(streamId, Number.isFinite(configured) && configured > 0 ? configured : 1);
			state.streams++;
			refreshPriority(state);
			active.set(owner, (active.get(owner) || 0) + 1);
			try {
			for await (const chunk of source) {
				for (let offset = 0; offset < chunk.length; offset += quantum) {
					const part = chunk.subarray(offset, offset + quantum);
					await take(part.length, signal, owner, account);
					if (signal?.aborted) throw signal.reason;
					yield part;
				}
			}
			} finally {
				state.priorities.delete(streamId);
				state.streams = Math.max(0, state.streams - 1);
				refreshPriority(state);
				if (!state.streams) state.deficit = 0;
				const remaining = active.get(owner) - 1;
				if (remaining) active.set(owner, remaining);
				else active.delete(owner);
				if (!state.streams && accounts.size > 500) accounts.delete(account);
			}
		}
	};
}
