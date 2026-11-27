#!/usr/bin/env node
// Legt .env aus .env.example an und füllt leere Geheimnisse mit Zufallswerten (nur für Entwicklung und Pilot).
// Bereits gesetzte Werte bleiben unverändert – vor allem NETWORK_HMAC_SECRET darf sich nicht ändern, sobald Netze
// gespeichert sind. Aufruf: pnpm init:env
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const SECRETS = {
  JWT_SECRET: () => randomBytes(48).toString('base64'),
  TOTP_ENCRYPTION_KEY: () => randomBytes(32).toString('base64'),
  NETWORK_HMAC_SECRET: () => randomBytes(48).toString('base64'),
};

if (!existsSync('.env')) {
  copyFileSync('.env.example', '.env');
  console.log('.env aus .env.example angelegt.');
}
const filled = [];
const lines = readFileSync('.env', 'utf8')
  .split('\n')
  .map((line) => {
    const match = /^([A-Z_]+)=\s*$/.exec(line);
    if (match && match[1] in SECRETS) {
      filled.push(match[1]);
      return `${match[1]}=${SECRETS[match[1]]()}`;
    }
    return line;
  });
writeFileSync('.env', lines.join('\n'));
console.log(filled.length ? `Erzeugt: ${filled.join(', ')}` : 'Alle Geheimnisse waren schon gesetzt.');
