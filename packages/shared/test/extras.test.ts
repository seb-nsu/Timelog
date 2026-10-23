import { describe, expect, it } from 'vitest';
import {
  createApiClient,
  networkInput,
  networkResponse,
  orgFeatures,
  projectAssignmentInput,
  projectInput,
  settingsSchema,
  suggestionsQuery,
} from '../src/index.js';

describe('Schemas für Projekte, Kalender und Homeoffice', () => {
  it('Projekte: Standardfarbe, Stichwörter begrenzt', () => {
    expect(projectInput.parse({ name: 'Alpha' })).toEqual({
      name: 'Alpha',
      color: '#1d4ed8',
      keywords: [],
    });
    expect(projectInput.safeParse({ name: 'A', color: 'red' }).success).toBe(false);
    expect(projectInput.safeParse({ name: 'A', keywords: ['x'] }).success).toBe(false);
  });

  it('Zuordnung: Ende nach Beginn, höchstens 24 h, null erlaubt', () => {
    const ok = { from: '2026-10-14T08:00:00Z', to: '2026-10-14T09:00:00Z', projectId: null };
    expect(projectAssignmentInput.safeParse(ok).success).toBe(true);
    expect(projectAssignmentInput.safeParse({ ...ok, to: ok.from }).success).toBe(false);
    expect(projectAssignmentInput.safeParse({ ...ok, to: '2026-10-15T09:00:01Z' }).success).toBe(
      false,
    );
  });

  it('Netze: Ort standardmäßig Büro, auch in alten Antworten', () => {
    const n = networkInput.parse({ kind: 'fingerprint', label: 'Büro', fingerprint: 'abcdefgh' });
    expect(n.location).toBe('office');
    expect(
      networkResponse.parse({
        id: '0b7a1c4e-2f43-4d4f-9d7e-6f1a2b3c4d5e',
        scope: 'user',
        kind: 'fingerprint',
        label: 'x',
      }).location,
    ).toBe('office');
  });

  it('Einstellungen und Firmen-Schalter haben sichere Standardwerte', () => {
    expect(settingsSchema.parse({}).projects).toBe(false);
    expect(orgFeatures.parse({})).toEqual({
      projects: false,
      calendar: true,
      homeOfficeReport: false,
    });
    expect(suggestionsQuery.safeParse({ from: '2026-01-01', to: '2026-12-31' }).success).toBe(
      false,
    );
  });
});

describe('API-Client', () => {
  it('ruft die neuen Endpunkte mit Pfad und Methode auf', async () => {
    const calls: string[] = [];
    const client = createApiClient({
      baseUrl: 'https://api.example',
      fetch: (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        calls.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`);
        return Promise.resolve(new Response(JSON.stringify({ url: 'https://idp.example/x' })));
      },
    });
    await client.calendar.connect('google', 'https://app.example/back');
    expect(calls).toEqual(['POST /api/v1/calendar/google/connect']);
    await expect(client.locations.export({ year: 2026, format: 'csv' })).resolves.toBeInstanceOf(
      Blob,
    );
    expect(calls[1]).toBe('GET /api/v1/locations/export?year=2026&format=csv');
  });
});
