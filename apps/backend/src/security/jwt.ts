import { SignJWT, jwtVerify } from 'jose';
import { z } from 'zod';

export const ACCESS_TOKEN_TTL_S = 15 * 60;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const claimsSchema = z.object({
  sub: z.uuid(),
  did: z.uuid(),
  org: z.uuid().nullable(),
  role: z.enum(['user', 'manager', 'admin']),
  mfa: z.boolean(),
});

export type AccessClaims = z.infer<typeof claimsSchema>;

export class TokenSigner {
  private readonly key: Uint8Array;

  constructor(secret: string) {
    this.key = new TextEncoder().encode(secret);
  }

  sign(claims: AccessClaims, nowMs: number): Promise<string> {
    const { sub, ...rest } = claims;
    const iat = Math.floor(nowMs / 1000);
    return new SignJWT(rest)
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(sub)
      .setIssuedAt(iat)
      .setExpirationTime(iat + ACCESS_TOKEN_TTL_S)
      .setAudience('timelog-api')
      .sign(this.key);
  }

  async verify(token: string, nowMs: number): Promise<AccessClaims | undefined> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        algorithms: ['HS256'],
        audience: 'timelog-api',
        currentDate: new Date(nowMs),
      });
      const parsed = claimsSchema.safeParse(payload);
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }
}
