// Personio Public API v2 (Attendance Periods). v1-Attendances sind abgekündigt (Abschaltung laut
// Personio-Changelog zum 31.01.2027), daher nur v2.
// Doku: https://developer.personio.de/reference/post_v2-auth-token,
//       https://developer.personio.de/reference/get_v2-persons,
//       https://developer.personio.de/reference/post_v2-attendance-periods,
//       https://developer.personio.de/reference/delete_v2-attendance-periods-id
import { z } from 'zod';
import type { PersonioOptions } from '../app.js';

export class PersonioError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`personio ${String(status)} ${code}`);
  }
}

const tokenResponse = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().optional(),
});
const personsResponse = z.object({
  _data: z.array(
    z.object({
      id: z.union([z.string(), z.number()]).transform(String),
      email: z.string().optional(),
    }),
  ),
});
const createdResponse = z.object({
  id: z.string(),
  affected_periods: z.array(z.object({ id: z.string() })).optional(),
});
/** Fehlerantwort im Format application/problem+json; nur der Typ wird übernommen. */
const problem = z.object({ type: z.string().optional(), title: z.string().optional() }).loose();

export interface PersonioPeriod {
  /** Lokale Zeit ohne Offset, z. B. 2026-09-01T08:00:00 (DateTimeWithoutTimezone). */
  start: string;
  end: string;
}

export class PersonioClient {
  private token: string | undefined;

  constructor(
    private readonly opts: PersonioOptions,
    private readonly clientId: string,
    private readonly clientSecret: string,
  ) {}

  private async fail(res: Response): Promise<never> {
    let code = 'http_error';
    try {
      const p = problem.safeParse(await res.json());
      if (p.success) code = p.data.type ?? p.data.title ?? code;
    } catch {
      // keine JSON-Antwort
    }
    throw new PersonioError(res.status, code.slice(0, 120));
  }

  private async auth(): Promise<string> {
    if (this.token) return this.token;
    const res = await this.opts.fetch(`${this.opts.baseUrl}/v2/auth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }).toString(),
    });
    if (!res.ok) return this.fail(res);
    this.token = tokenResponse.parse(await res.json()).access_token;
    return this.token;
  }

  private async call(method: string, path: string, body?: unknown): Promise<Response> {
    const token = await this.auth();
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const init: RequestInit = { method, headers };
    if (body !== undefined) init.body = JSON.stringify(body);
    return this.opts.fetch(`${this.opts.baseUrl}${path}`, init);
  }

  /** Personio-ID zur E-Mail-Adresse (Filter `email`). */
  async personIdByEmail(email: string): Promise<string | undefined> {
    const res = await this.call(
      'GET',
      `/v2/persons?${new URLSearchParams({ email, limit: '2' }).toString()}`,
    );
    if (!res.ok) return this.fail(res);
    const data = personsResponse.parse(await res.json())._data;
    const match = data.filter((p) => p.email?.toLowerCase() === email.toLowerCase());
    return (match.length === 1 ? match[0] : data.length === 1 ? data[0] : undefined)?.id;
  }

  /** Legt eine Arbeitsperiode (WORK) an und liefert ihre ID. */
  async createWork(
    personId: string,
    period: PersonioPeriod,
    comment: string,
    skipApproval: boolean,
  ): Promise<string> {
    const res = await this.call(
      'POST',
      `/v2/attendance-periods${skipApproval ? '?skip_approval=true' : ''}`,
      {
        person: { id: personId },
        type: 'WORK',
        start: { date_time: period.start },
        end: { date_time: period.end },
        comment,
      },
    );
    if (!res.ok) return this.fail(res);
    return createdResponse.parse(await res.json()).id;
  }

  /** Entfernt eine früher übertragene Periode (404 = schon weg). */
  async deletePeriod(id: string): Promise<void> {
    const res = await this.call('DELETE', `/v2/attendance-periods/${encodeURIComponent(id)}`);
    if (!res.ok && res.status !== 404) await this.fail(res);
  }
}
