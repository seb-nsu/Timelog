// Protokolle ohne personenbezogene Inhalte: keine IP-Adresse, kein Hostname, keine Query
// (dort können Bestätigungs- oder Reset-Tokens stehen), keine Header außer der Request-ID.
import type { FastifyRequest } from 'fastify';

export function serializeRequest(req: FastifyRequest): { id: string; method: string; url: string } {
  const url = req.routeOptions.url ?? req.url.split('?')[0] ?? '';
  return { id: req.id, method: req.method, url };
}

export function serializeReply(reply: { statusCode: number }): { statusCode: number } {
  return { statusCode: reply.statusCode };
}

export const logSerializers = { req: serializeRequest, res: serializeReply };
