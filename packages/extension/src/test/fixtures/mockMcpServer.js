const mode = process.argv[2] || 'framed';
let buffer = '';

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  drain();
});

function send(obj) {
  const raw = JSON.stringify(obj);
  if (mode === 'framed') {
    process.stdout.write('Content-Length: ' + Buffer.byteLength(raw, 'utf8') + '\r\n\r\n' + raw);
  } else {
    process.stdout.write(raw + '\n');
  }
}

function handle(msg) {
  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        serverInfo: { name: 'mock', version: '1.0.0' },
      },
    });
    return;
  }
  if (msg.method === 'notifications/initialized') return;
  if (msg.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        tools: [
          {
            name: 'echo',
            description: 'Echo input message',
            inputSchema: {
              type: 'object',
              properties: { message: { type: 'string' } },
              required: ['message'],
            },
          },
          {
            name: 'structured',
            description: 'Returns structured payload',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      },
    });
    return;
  }
  if (msg.method === 'tools/call') {
    if (msg.params && msg.params.name === 'echo') {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          content: [{ type: 'text', text: String((msg.params.arguments || {}).message || '') }],
        },
      });
      return;
    }
    if (msg.params && msg.params.name === 'structured') {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          structuredContent: { ok: true, source: 'mock' },
        },
      });
      return;
    }
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'unknown tool' } });
    return;
  }
  if (typeof msg.id === 'number') {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } });
  }
}

function drain() {
  while (buffer.length > 0) {
    if (mode === 'framed') {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const header = buffer.slice(0, headerEnd);
      const m = header.match(/content-length\s*:\s*(\d+)/i);
      if (!m) {
        buffer = buffer.slice(headerEnd + 4);
        continue;
      }
      const bodyLength = Number.parseInt(m[1], 10);
      const bodyStart = headerEnd + 4;
      if (buffer.length < bodyStart + bodyLength) return;
      const body = buffer.slice(bodyStart, bodyStart + bodyLength);
      buffer = buffer.slice(bodyStart + bodyLength);
      let parsed;
      try { parsed = JSON.parse(body); } catch { continue; }
      handle(parsed);
      continue;
    }

    const lineEnd = buffer.indexOf('\n');
    if (lineEnd < 0) return;
    const line = buffer.slice(0, lineEnd).trim();
    buffer = buffer.slice(lineEnd + 1);
    if (!line) continue;
    let parsed;
    try { parsed = JSON.parse(line); } catch { continue; }
    handle(parsed);
  }
}
