#!/usr/bin/env node
// Mimics llama-server enough for supervisor + API tests.
// Args mirror the real ones; only --port matters. Env knobs:
//   STUB_LOAD_MS   time to stay in "loading" (503) state (default 300)
//   STUB_CRASH_MS  if set, exit(1) after this many ms
import { createServer } from 'node:http';

const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
const loadMs = Number(process.env.STUB_LOAD_MS ?? 300);
const started = Date.now();
if (process.env.STUB_CRASH_MS) {
  setTimeout(() => { console.error('boom: simulated crash'); process.exit(1); }, Number(process.env.STUB_CRASH_MS));
}
createServer((req, res) => {
  if (req.url === '/health') {
    if (Date.now() - started < loadMs) { res.writeHead(503); res.end('{"error":{"code":503,"message":"Loading model"}}'); }
    else { res.writeHead(200); res.end('{"status":"ok"}'); }
    return;
  }
  if (req.url === '/v1/chat/completions') {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"stub"}}]}\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }
  res.writeHead(404); res.end();
}).listen(port, '127.0.0.1');
process.on('SIGTERM', () => process.exit(0));
