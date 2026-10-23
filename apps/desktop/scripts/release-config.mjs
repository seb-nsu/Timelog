// Erzeugt die zusätzliche Tauri-Konfiguration für Release-Builds: Updater (öffentlicher
// Schlüssel, Adresse) und optional der Signaturbefehl für Windows. Werte nur aus der Umgebung,
// damit nichts davon im Repository steht. Aufruf: node release-config.mjs <ziel.json>
import { writeFileSync } from 'node:fs';

const target = process.argv[2];
if (!target) throw new Error('Ziel-Datei fehlt');

const pubkey = process.env.UPDATER_PUBKEY?.trim();
if (!pubkey)
  throw new Error('UPDATER_PUBKEY fehlt (öffentlicher Schlüssel aus `pnpm tauri signer generate`)');

const repository = process.env.REPOSITORY ?? '';
const endpoint =
  process.env.UPDATER_ENDPOINT?.trim() ||
  `https://github.com/${repository}/releases/latest/download/latest.json`;
if (!endpoint.startsWith('https://')) throw new Error('UPDATER_ENDPOINT muss https sein');

const config = {
  bundle: { createUpdaterArtifacts: true },
  plugins: { updater: { pubkey, endpoints: [endpoint] } },
};

const signCommand = process.env.WINDOWS_SIGN_COMMAND?.trim();
if (signCommand) config.bundle.windows = { signCommand };

writeFileSync(target, `${JSON.stringify(config, null, 2)}\n`);
console.log(`Release-Konfiguration geschrieben: ${target}`);
