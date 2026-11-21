import net from 'node:net';

export function createUsbHelperClient(socketPath, timeout = 10000) {
	function request(payload) {
		return new Promise((resolve, reject) => {
			const socket = net.createConnection({ path: socketPath });
			let buffer = '';
			const timer = setTimeout(() => { socket.destroy(); reject(new Error('USB helper did not answer.')); }, timeout);
			socket.setEncoding('utf8');
			socket.on('connect', () => socket.write(JSON.stringify(payload) + '\n'));
			socket.on('data', chunk => {
				buffer += chunk;
				if (buffer.length > 1024 * 1024) { clearTimeout(timer); socket.destroy(); reject(new Error('USB helper response was too large.')); return; }
				const newline = buffer.indexOf('\n');
				if (newline < 0) return;
				clearTimeout(timer); socket.end();
				try {
					const data = JSON.parse(buffer.slice(0, newline));
					if (!data.ok) reject(Object.assign(new Error(data.error || 'USB helper refused the request.'), { status: data.status || 500 }));
					else resolve(data);
				} catch (error) { reject(error); }
			});
			socket.on('error', error => { clearTimeout(timer); reject(error); });
		});
	}
	return {
		status: () => request({ action: 'status' }),
		mount: (device, identity) => request({ action: 'mount', device, identity }),
		eject: (device, identity) => request({ action: 'eject', device, identity }),
		request
	};
}
