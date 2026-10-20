import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { MobileCore } from '../src/core/core';
import { Store } from '../src/core/store';
import { type FakeNative, fakeNative } from './fakeNative';
import { type FakeServer, fakeServer } from './fakeServer';
import { memoryDb } from './sqlite';

export interface Clock {
  (): number;
  set: (iso: string) => void;
  advance: (minutes: number) => void;
}

export function clock(iso: string): Clock {
  let now = Date.parse(iso);
  const c = (() => now) as Clock;
  c.set = (value) => {
    now = Date.parse(value);
  };
  c.advance = (minutes) => {
    now += minutes * 60_000;
  };
  return c;
}

export interface Harness {
  core: MobileCore;
  server: FakeServer;
  native: FakeNative;
  clock: Clock;
  secure: Map<string, string>;
}

export async function harness(
  opts: { now?: string; native?: FakeNative; server?: FakeServer } = {},
): Promise<Harness> {
  const c = clock(opts.now ?? '2026-10-15T07:00:00Z');
  const server = opts.server ?? fakeServer(c);
  const native = opts.native ?? fakeNative();
  const secure = new Map<string, string>();
  const store = await Store.open(memoryDb());
  const core = new MobileCore({
    store,
    native,
    fetch: server.fetch,
    clock: c,
    uuid: () => randomUUID(),
    timezone: () => 'Europe/Berlin',
    device: { os: 'android 16', name: 'Pixel' },
    crypto: {
      sha256: (data) => Promise.resolve(new Uint8Array(createHash('sha256').update(data).digest())),
      randomBytes: (n) => new Uint8Array(randomBytes(n)),
    },
    secure: {
      getItem: (k) => Promise.resolve(secure.get(k) ?? null),
      setItem: (k, v) => {
        secure.set(k, v);
        return Promise.resolve();
      },
      deleteItem: (k) => {
        secure.delete(k);
        return Promise.resolve();
      },
    },
  });
  return { core, server, native, clock: c, secure };
}

export async function loggedIn(opts: Parameters<typeof harness>[0] = {}): Promise<Harness> {
  const h = await harness(opts);
  await h.core.login({
    baseUrl: 'https://zeit.example/',
    email: 'a@b.de',
    password: 'geheim-geheim',
  });
  await h.core.sync(true);
  return h;
}
