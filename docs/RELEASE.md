# Desktop-Release

Der Workflow `.github/workflows/release.yml` baut signierte Pakete für Windows (MSI) und macOS
(DMG, Apple Silicon und Intel) und legt sie als **Entwurf** eines GitHub-Release ab. Er läuft nur
manuell (*Actions → Release Desktop → Run workflow*) oder bei einem Tag `desktop-v*`, also nie bei
normalen Pushes.

## Ablauf

1. Version in `apps/desktop/src-tauri/tauri.conf.json`, `apps/desktop/package.json` und
   `apps/desktop/src-tauri/Cargo.toml` erhöhen und committen.
2. Tag setzen: `git tag desktop-v0.2.0 && git push origin desktop-v0.2.0`.
3. Den Release-Entwurf prüfen (Pakete installieren, siehe 👤 unten) und veröffentlichen. Erst
   dann zeigt `releases/latest/download/latest.json` auf die neue Version, und installierte
   Apps aktualisieren sich (Prüfung eine Minute nach dem Start, dann täglich).

## Einmalige Einrichtung

### Update-Signatur (Pflicht)

```sh
pnpm --filter @timelog/desktop tauri signer generate -w ~/.tauri/timelog.key
```

| Wo | Name | Inhalt |
| --- | --- | --- |
| Secret | `TAURI_SIGNING_PRIVATE_KEY` | Inhalt von `~/.tauri/timelog.key` |
| Secret | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Passwort des Schlüssels |
| Variable | `UPDATER_PUBKEY` | Inhalt von `~/.tauri/timelog.key.pub` |
| Variable | `UPDATER_ENDPOINT` | optional; Standard: `latest.json` des neuesten GitHub-Release |

Der private Schlüssel gehört zusätzlich in einen Passwort-Tresor. Geht er verloren, können
installierte Apps keine Updates mehr annehmen und müssen neu installiert werden.

`apps/desktop/scripts/release-config.mjs` schreibt daraus beim Build
`src-tauri/release.conf.json` (`plugins.updater`, `bundle.createUpdaterArtifacts`). Ohne diese
Datei, also in Entwicklungs-Builds, ist der Updater aus.

### macOS: Developer ID und Notarisierung

Voraussetzung ist ein Apple-Developer-Konto (Organisation).

| Secret | Inhalt |
| --- | --- |
| `APPLE_CERTIFICATE` | Developer-ID-Application-Zertifikat als `.p12`, Base64 |
| `APPLE_CERTIFICATE_PASSWORD` | Passwort der `.p12` |
| `APPLE_SIGNING_IDENTITY` | z. B. `Developer ID Application: Firma GmbH (TEAMID)` |
| `APPLE_ID` | Apple-ID für die Notarisierung |
| `APPLE_PASSWORD` | app-spezifisches Passwort dieser Apple-ID |
| `APPLE_TEAM_ID` | Team-ID |

### Windows: Azure Artifact Signing

Voraussetzung ist ein Azure-Artifact-Signing-Konto (früher Trusted Signing) mit
Zertifikatsprofil und einer App-Registrierung mit der Rolle *Artifact Signing Certificate
Profile Signer*.

| Wo | Name | Inhalt |
| --- | --- | --- |
| Secret | `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID` | App-Registrierung |
| Variable | `WINDOWS_SIGN_COMMAND` | z. B. `artifact-signing-cli -e https://weu.codesigning.azure.net -a Konto -c Profil -d TimeLog %1` |

Ist `WINDOWS_SIGN_COMMAND` leer, entsteht ein unsigniertes MSI (SmartScreen warnt).

Quellen: [tauri-action](https://github.com/tauri-apps/tauri-action),
[Updater](https://v2.tauri.app/plugin/updater/),
[macOS-Signierung](https://v2.tauri.app/distribute/sign/macos/),
[Windows-Signierung](https://v2.tauri.app/distribute/sign/windows/).

## 👤 Prüfung vor dem Veröffentlichen

- [ ] Windows: MSI installieren; Eigenschaften → Digitale Signaturen zeigt den Herausgeber;
      kein SmartScreen-Hinweis „Unbekannter Herausgeber“.
- [ ] macOS: DMG öffnen, App starten; `spctl -a -vv /Applications/TimeLog.app` meldet
      „accepted, source=Notarized Developer ID“.
- [ ] Update: ältere Version installieren, neue veröffentlichen, App starten; nach etwa einer
      Minute startet sie mit der neuen Version neu, die laufende Erfassung geht weiter.
- [ ] Anmeldung bleibt nach dem Update erhalten (Schlüsselbund).
