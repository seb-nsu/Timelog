import { Writable } from 'node:stream';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { logSerializers } from '../src/log.js';

describe('Protokolle', () => {
  it('enthalten weder IP-Adresse noch Hostname noch Query', async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _enc, done) {
        lines.push(chunk.toString());
        done();
      },
    });
    const app = Fastify({ logger: { level: 'info', stream, serializers: logSerializers } });
    app.get('/verify', () => ({ ok: true }));
    await app.inject({
      url: '/verify?token=geheim&email=a%40b.de',
      headers: { 'x-forwarded-for': '203.0.113.7' },
      remoteAddress: '198.51.100.9',
    });
    await app.close();
    const log = lines.join('');
    expect(log).toContain('"url":"/verify"');
    expect(log).toContain('"statusCode":200');
    for (const secret of [
      'geheim',
      'a%40b.de',
      '198.51.100.9',
      '203.0.113.7',
      'remoteAddress',
      'hostname":"localhost',
    ]) {
      expect(log).not.toContain(secret);
    }
  });
});
