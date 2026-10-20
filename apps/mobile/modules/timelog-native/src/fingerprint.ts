// Referenz für das Format der Netzwerk-Kennung auf dem Handy. Die Kennung wird im nativen Teil
// berechnet (Android: NetworkFingerprint.kt), weil sie auch bei beendeter App gebraucht wird;
// beide Umsetzungen prüfen sich gegen fingerprint-vectors.json.
//
// Format:
//  1. Ist die MAC-Adresse des Gateways bekannt: `gw=aa:bb:cc:dd:ee:ff` – identisch zum Desktop.
//     (Android liefert sie seit Version 10 nicht mehr, /proc/net ist gesperrt.)
//  2. Sonst aus LinkProperties (ohne Standortberechtigung), nur IPv4, Felder sortiert und ohne
//     Dubletten, leere Felder entfallen:
//     `v4;gw=<Gateway-IP>;net=<Netz>/<Präfix>;dns=<DNS-Server>;dom=<Suchdomänen>`
//     z. B. `v4;gw=10.1.0.1;net=10.1.0.0/16;dns=10.1.0.10,10.1.0.11;dom=corp.example.com`
//  3. Ohne IPv4-Gateway: keine Kennung (null).
// Zum Server geht die Kennung nur beim Hinterlegen; gespeichert wird dort ein HMAC.

export interface LinkInfo {
  gatewayMac?: string | null;
  /** IPv4-Gateways der Standardroute */
  gateways: string[];
  /** IPv4-Adressen der Schnittstelle mit Präfixlänge */
  addresses: { address: string; prefixLength: number }[];
  dnsServers: string[];
  /** Suchdomänen, wie Android sie liefert (Komma oder Leerzeichen getrennt) */
  domains: string | null;
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function parseIpv4(ip: string): number | null {
  const m = IPV4.exec(ip.trim());
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return parts.reduce((acc, p) => acc * 256 + p, 0);
}

function formatIpv4(n: number): string {
  return [24, 16, 8, 0].map((s) => String(Math.floor(n / 2 ** s) % 256)).join('.');
}

/** Link-lokal (169.254/16), Loopback (127/8) und 0.0.0.0 taugen nicht als Kennung. */
function usable(n: number): boolean {
  const first = Math.floor(n / 2 ** 24);
  const second = Math.floor(n / 2 ** 16) % 256;
  return n !== 0 && first !== 127 && !(first === 169 && second === 254);
}

function normalizeMac(mac: string): string | null {
  const parts = mac.trim().toLowerCase().replace(/-/g, ':').split(':');
  if (parts.length !== 6 || parts.some((p) => !/^[0-9a-f]{1,2}$/.test(p))) return null;
  const bytes = parts.map((p) => p.padStart(2, '0'));
  if (bytes.every((b) => b === '00') || bytes.every((b) => b === 'ff')) return null;
  return bytes.join(':');
}

const unique = (values: string[]) => [...new Set(values)].sort();

export function networkFingerprint(link: LinkInfo): string | null {
  const mac = link.gatewayMac ? normalizeMac(link.gatewayMac) : null;
  if (mac) return `gw=${mac}`;

  const gateways = unique(
    link.gateways
      .map(parseIpv4)
      .filter((n): n is number => n !== null && usable(n))
      .map(formatIpv4),
  );
  if (gateways.length === 0) return null;

  const nets = unique(
    link.addresses.flatMap(({ address, prefixLength }) => {
      const n = parseIpv4(address);
      if (n === null || !usable(n) || prefixLength < 0 || prefixLength > 32) return [];
      const size = 2 ** (32 - prefixLength);
      return [`${formatIpv4(Math.floor(n / size) * size)}/${String(prefixLength)}`];
    }),
  );
  const dns = unique(
    link.dnsServers
      .map(parseIpv4)
      .filter((n): n is number => n !== null && usable(n))
      .map(formatIpv4),
  );
  const domains = unique(
    (link.domains ?? '')
      .toLowerCase()
      .split(/[\s,]+/)
      .map((d) => d.replace(/\.$/, ''))
      .filter((d) => d.length > 0),
  );

  const fields = [`gw=${gateways.join(',')}`];
  if (nets.length > 0) fields.push(`net=${nets.join(',')}`);
  if (dns.length > 0) fields.push(`dns=${dns.join(',')}`);
  if (domains.length > 0) fields.push(`dom=${domains.join(',')}`);
  return `v4;${fields.join(';')}`;
}

/** Suchdomänen typischer Heimrouter mit Werkseinstellung. */
const CONSUMER_DOMAINS = new Set([
  'fritz.box',
  'speedport.ip',
  'home',
  'lan',
  'local',
  'localdomain',
  'box',
  'home.arpa',
]);

/**
 * Kennungen ohne eigene Domäne, bei denen der Router zugleich DNS-Server ist, sehen bei vielen
 * Heimroutern gleich aus (z. B. jede FRITZ!Box mit Werkseinstellung). Die App warnt dann.
 */
export function isWeakFingerprint(fingerprint: string): boolean {
  if (!fingerprint.startsWith('v4;')) return false;
  const fields = new Map(
    fingerprint
      .slice(3)
      .split(';')
      .map((f) => {
        const i = f.indexOf('=');
        return [f.slice(0, i), f.slice(i + 1)] as const;
      }),
  );
  const domains = (fields.get('dom') ?? '').split(',').filter((d) => d.length > 0);
  if (domains.length > 0 && domains.some((d) => !CONSUMER_DOMAINS.has(d))) return false;
  const dns = (fields.get('dns') ?? '').split(',');
  const gateways = (fields.get('gw') ?? '').split(',');
  return domains.length > 0 || dns.every((d) => d === '' || gateways.includes(d));
}

/** Gleiche Normalisierung wie Backend und Desktop vor dem HMAC. */
export function normalizeForHmac(value: string): string {
  return value.trim().toLowerCase().replace(/-/g, ':');
}
