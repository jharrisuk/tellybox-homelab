import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

// One shared allowance for every remote media response, not one limit per viewer.
export function createUploadLimit(directory, {clock=Date.now}={}) {
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
	let updated = performance.now();
	let timer;
	let transferredBytes = 0;
	const queue = [];
	const active = new Map();
	const turns = new Map();
	const samples = new Map();
	const windowMs = 10000;
	function measured(owner, now = performance.now()) {
		let bytes = 0;
		for (const [key, buckets] of samples) {
			for (const [second, count] of buckets) {
				if (second * 1000 <= now - windowMs) buckets.delete(second);
				else if (owner === undefined || owner === key) bytes += count;
			}
			if (!buckets.size) samples.delete(key);
		}
		return Math.round(bytes * 8 / windowMs / 1000 * 100) / 100;
	}
	let turn = 0;
	function refill() {
		const now = performance.now();rate=effective();
		tokens = Math.min(burst, tokens + (now - updated) * rate * 125);
		updated = now;
	}
	function drain() {
		clearTimeout(timer); timer = null;
		refill();
		while (queue.length) {
			// Round-robin logical streams, including clients that fetch several HLS
			// segments concurrently. Idle registered devices never enter this queue.
			queue.sort((a, b) => (turns.get(a.owner) || 0) - (turns.get(b.owner) || 0));
			const request = queue[0];
			if (rate && tokens < request.bytes) {
				timer = setTimeout(drain, Math.max(1, Math.ceil((request.bytes - tokens) / (rate * 125))));
				return;
			}
			queue.shift();
			turns.set(request.owner, ++turn);
			if (rate) tokens -= request.bytes;
			request.signal?.removeEventListener('abort', request.abort);
			transferredBytes += request.bytes;
			const second = Math.floor(performance.now() / 1000);
			if (!samples.has(request.owner)) samples.set(request.owner, new Map());
			const buckets = samples.get(request.owner);
			buckets.set(second, (buckets.get(second) || 0) + request.bytes);
			// Bound storage even if nobody opens diagnostics.
			if (buckets.size > 11 || samples.size > 100) measured();
			request.resolve();
		}
	}
	function take(bytes, signal, owner) {
		return new Promise((resolve, reject) => {
			const request = { bytes, resolve, signal, owner, abort: () => {
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
		async *stream(source, signal, owner = Symbol('transfer')) {
			active.set(owner, (active.get(owner) || 0) + 1);
			try {
			for await (const chunk of source) {
				for (let offset = 0; offset < chunk.length; offset += quantum) {
					const part = chunk.subarray(offset, offset + quantum);
					await take(part.length, signal, owner);
					if (signal?.aborted) throw signal.reason;
					yield part;
				}
			}
			} finally {
				const remaining = active.get(owner) - 1;
				if (remaining) active.set(owner, remaining);
				else { active.delete(owner); turns.delete(owner); }
			}
		}
	};
}
