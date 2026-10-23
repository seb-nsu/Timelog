import { describe, expect, it } from '@jest/globals';
import { createHash, createHmac } from 'node:crypto';
import { hmacHex } from '../src/core/hmac';
import { harness, loggedIn } from './helpers';

const sha256 = (d: Uint8Array) =>
  Promise.resolve(new Uint8Array(createHash('sha256').update(d).digest()));

describe('HMAC-SHA256', () => {
  it('stimmt mit node:crypto überein (kurzer und langer Schlüssel)', async () => {
    for (const key of [Buffer.alloc(32, 7), Buffer.alloc(100, 3)]) {
      const msg = 'v4;gw=10.1.0.1;net=10.1.0.0/16';
      const expected = createHmac('sha256', key).update(msg).digest('hex');
      expect(await hmacHex(sha256, key.toString('base64'), msg)).toBe(expected);
    }
  });
});

describe('Aktuelles Netz übernehmen', () => {
  it('mit Konto: Server speichert den HMAC, das Modul bekommt das Netz', async () => {
    const h = await loggedIn();
    const res = await h.core.addCurrentNetwork('Büro');
    expect(res).toMatchObject({ status: 'added', weak: false });
    expect(h.server.networks).toHaveLength(1);
    expect(h.native.configs.at(-1)?.detection).toBe(true);
    expect(JSON.stringify(h.native.configs.at(-1))).not.toContain('10.1.0.1');
  });

  it('warnt bei typischer Router-Werkseinstellung', async () => {
    const h = await loggedIn();
    h.native.network = {
      ...h.native.network,
      fingerprint: 'v4;gw=192.168.178.1;net=192.168.178.0/24;dns=192.168.178.1;dom=fritz.box',
    };
    expect(await h.core.addCurrentNetwork('Zuhause?')).toMatchObject({
      status: 'added',
      weak: true,
    });
  });

  it('ohne erkanntes Netz nichts speichern', async () => {
    const h = await loggedIn();
    h.native.network = { ...h.native.network, fingerprint: null, transport: 'none' };
    expect(await h.core.addCurrentNetwork('X')).toEqual({ status: 'none' });
    expect(h.server.networks).toHaveLength(0);
  });

  it('nur lokal: eigener Schlüssel, nur HMAC, Entfernen schaltet Erkennung ab', async () => {
    const h = await harness();
    await h.core.useLocalOnly();
    const res = await h.core.addCurrentNetwork('Büro');
    expect(res.status).toBe('added');
    const config = h.native.configs.at(-1);
    expect(config?.detection).toBe(true);
    const key = Buffer.from(config?.keys.user ?? '', 'base64');
    expect(key).toHaveLength(32);
    const expected = createHmac('sha256', key)
      .update(h.native.network.fingerprint ?? '')
      .digest('hex');
    expect(config?.networks[0]?.fingerprintHmac).toBe(expected);
    expect(JSON.stringify(await h.core.networks())).not.toContain('10.1.0.1');
    expect(h.server.requests).toHaveLength(0);
    if (res.status === 'added') await h.core.removeNetwork(res.id);
    expect(h.native.configs.at(-1)?.detection).toBe(false);
  });
});

describe('Abwesenheiten', () => {
  it('mit Konto über den Server, danach im Profil', async () => {
    const h = await loggedIn();
    await h.core.saveAbsences('2026-10-19', '2026-10-23', [
      { date: '2026-10-19', kind: 'vacation', minutes: 480 },
    ]);
    expect(h.server.absences).toHaveLength(1);
    expect((await h.core.profile()).absences).toEqual([
      { date: '2026-10-19', kind: 'vacation', minutes: 480 },
    ]);
  });

  it('nur lokal ersetzt den Zeitraum', async () => {
    const h = await harness();
    await h.core.useLocalOnly();
    await h.core.saveAbsences('2026-10-19', '2026-10-20', [
      { date: '2026-10-19', kind: 'sick', minutes: 480 },
      { date: '2026-10-20', kind: 'sick', minutes: 480 },
    ]);
    await h.core.saveAbsences('2026-10-20', '2026-10-20', []);
    expect((await h.core.profile()).absences?.map((a) => a.date)).toEqual(['2026-10-19']);
  });
});

describe('Datenauskunft, Geräte, Tagesabschluss', () => {
  it('nur lokal: exportiert lokale Daten und löscht sie vollständig', async () => {
    const h = await harness();
    await h.core.useLocalOnly();
    await h.core.manual('manual_start');
    const data = (await h.core.dataExport()) as { events: unknown[] };
    expect(data.events).toHaveLength(1);
    await h.core.wipeLocal();
    expect(await h.core.events('1970-01-01T00:00:00Z', '9999-01-01T00:00:00Z')).toHaveLength(0);
    expect((await h.core.getState()).account).toBe('none');
  });

  it('mit Konto: Geräte und Tagesabschluss', async () => {
    const h = await loggedIn();
    expect((await h.core.devices()).length).toBeGreaterThan(0);
    expect(await h.core.confirmDay('2026-10-14')).toBe(1);
  });
});
