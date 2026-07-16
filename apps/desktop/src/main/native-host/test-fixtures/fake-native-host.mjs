import net from 'node:net';
import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
const valueAfter = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const pipeName = valueAfter('--pipe');
const nonce = valueAfter('--nonce');
const mode = valueAfter('--fake-mode') ?? 'stable';
const methodTracePath = process.env.DESKTOP_TRANSLATE_E2E_NATIVE_TRACE;

if (!pipeName || !nonce) process.exit(2);

const encode = (message) => {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const frame = Buffer.alloc(4 + body.length);
  frame.writeUInt32LE(body.length, 0);
  body.copy(frame, 4);
  return frame;
};

const server = net.createServer((socket) => {
  let buffered = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= 4) {
      const length = buffered.readUInt32LE(0);
      if (buffered.length < 4 + length) return;
      const request = JSON.parse(buffered.subarray(4, 4 + length).toString('utf8'));
      buffered = buffered.subarray(4 + length);
      if (methodTracePath) appendFileSync(methodTracePath, `${request.method}\n`, 'utf8');
      const base = {
        v: 1,
        kind: 'response',
        id: request.id,
        timestamp: new Date().toISOString()
      };
      if (request.method === 'hello') {
        if (mode === 'exit-before-ready') process.exit(24);
        socket.write(
          encode({
            ...base,
            method: 'ready',
            payload: {
              selectedVersion: 1,
              hostVersion: 'fake-phase1',
              hostPid: String(process.pid),
              sessionNonce:
                mode === 'invalid-handshake'
                  ? `${nonce[0] === '0' ? '1' : '0'}${nonce.slice(1)}`
                  : nonce,
              capabilities: []
            }
          })
        );
        if (mode === 'crash') setTimeout(() => process.exit(23), 20);
      } else if (request.method === 'health') {
        const degraded = mode === 'degraded';
        socket.write(
          encode({
            ...base,
            method: 'health',
            payload: {
              status: degraded ? 'degraded' : 'ready',
              listening: false,
              uptimeMs: 1,
              ...(degraded ? { degradedCapabilities: ['ocr'] } : {})
            }
          })
        );
      } else if (request.method === 'shutdown') {
        socket.write(encode({ ...base, method: 'shutdown', payload: { ok: true } }));
        if (mode !== 'ignore-shutdown') setTimeout(() => process.exit(0), 10);
      } else {
        setTimeout(() => process.exit(70), 0);
      }
    }
  });
});

server.listen(pipeName);
