import { describe, it, expect } from 'vitest';
import express from 'express';
import http from 'node:http';
import { parsedBodyReplay } from '../dashboard/serve.js';

describe('sibling proxy request bodies', () => {
  it('re-sends a body the global JSON parser already consumed', () => {
    expect(parsedBodyReplay({ _body: true, body: { name: 'x' } })?.toString()).toBe('{"name":"x"}');
    expect(parsedBodyReplay({ _body: true, body: undefined })?.toString()).toBe('{}');
  });

  it('leaves unread streams (multipart uploads) to be piped', () => {
    expect(parsedBodyReplay({})).toBeNull();
  });

  it('express.json marks parsed requests the way the proxy expects', async () => {
    const app = express();
    app.use(express.json());
    let seen: Buffer | null = null;
    app.put('/x', (req, res) => { seen = parsedBodyReplay(req as never); res.end(); });
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    await new Promise<void>((resolve) => {
      const r = http.request({ port, method: 'PUT', path: '/x', headers: { 'content-type': 'application/json' } }, (res) => { res.resume(); res.on('end', () => resolve()); });
      r.end('{"a":1}');
    });
    server.close();
    expect(seen?.toString()).toBe('{"a":1}');
  });
});
