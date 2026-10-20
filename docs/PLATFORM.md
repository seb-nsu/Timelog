# Plattform-Erkennung Desktop

Wie der Desktop-Client Systemereignisse erkennt, was davon von den Herstellern dokumentiert ist
und was nur beobachtet wurde. Geprüft gegen Microsoft Learn und Apple Developer, Stand
20.10.2026. Die Arbeitszeit selbst berechnet weiterhin nur `packages/rules`; die Plattform-Module
liefern nur Signale an `timelog-core` (`trait SystemEvents`).

## Windows (`apps/desktop/src-tauri/src/platform/windows.rs`)

| Signal | Umsetzung | Quelle / Status |
| --- | --- | --- |
| Einschaltzeit | Jüngstes Ereignis 27 von `Microsoft-Windows-Kernel-Boot` im Protokoll „System“ mit `BootType` 0 (Kaltstart/Neustart) oder 1 (Schnellstart); `BootType` 2 (Fortsetzen aus Ruhezustand) wird übersprungen. Rückfall: Kernel-Start aus `GetTickCount64` | Abfrage per `EvtQuery`/`EvtRender` dokumentiert; Standardbenutzer dürfen „System“ lesen. **Die Bedeutung der `BootType`-Werte ist von Microsoft nicht dokumentiert**, nur beobachtet → am Gerät prüfen |
| Herunterfahren | Verstecktes Top-Level-Fenster. `WM_QUERYENDSESSION` wird sofort bestätigt, geschrieben wird in `WM_ENDSESSION`. `lParam & ENDSESSION_LOGOFF` → Logout → kein Ereignis. Die App wartet bis 4 s auf den SQLite-Eintrag und einen Sendeversuch (Windows beendet Programme ohne sichtbares Fenster nach etwa 5 s) | dokumentiert (WM_ENDSESSION, Shutdown Changes for Windows Vista) |
| Neustart / Update-Neustart | In `WM_ENDSESSION` wird das jüngste Ereignis 1074 (höchstens 10 min alt) gelesen: Art (`param5`) mit „Neustart“-Wörtern in mehreren Sprachen → `restart`; zusätzlich Grund „Betriebssystem: Installation/Upgrade/Service Pack/Hotfix/Sicherheitsupdate“ (`param4`) oder auslösender Windows-Update-Prozess (`param1`) → `restart` mit Kennzeichen `update_restart`. Sonst `shutdown` | Felder von 1074 nur an einem Beispiel dokumentiert; **dass 1074 vor `WM_QUERYENDSESSION` geschrieben wird und dass `param5` übersetzt ist, ist nicht dokumentiert**. Wird ein Neustart als `shutdown` erkannt, greift im Regelwerk `restartWindowMin` |
| Absturz | Kein `shutdown` vor dem neuen `boot`; offene Spannen enden beim Start bei ihrer letzten Verlängerung. Ereignis 6008 wird nicht gelesen, weil es nichts hinzufügt (Zeitpunkt steht nur im Meldungstext) | – |
| Sperren | `WTSRegisterSessionNotification` (`NOTIFY_FOR_THIS_SESSION`), Wiederholung, falls der Dienst kurz nach der Anmeldung noch fehlt | dokumentiert |
| Standby | `WM_POWERBROADCAST` `PBT_APMSUSPEND` / `PBT_APMRESUMEAUTOMATIC`; zusätzlich `RegisterSuspendResumeNotification`, denn im modernen Standbymodus bekommen nur so angemeldete Programme `PBT_APMSUSPEND`. Doppelte Meldungen werden zusammengefasst | dokumentiert (Desktop Activity Moderator) |
| Netzwechsel | `NotifyIpInterfaceChange`; Änderungen werden 3 s gebündelt. Der 2-min-Takt prüft das Netz zusätzlich | dokumentiert, keine Berechtigung nötig |
| Netzwerk-Kennung | `gw=<MAC des Standard-Gateways>`: Route mit kleinster Metrik aus `GetIpForwardTable2`, MAC aus dem Nachbar-Cache (`GetIpNetTable2`, nur lesen). LAN/WLAN aus dem Schnittstellentyp (`GetAdaptersAddresses`). Gesendet wird nur der HMAC | Keine Berechtigung auf den Referenzseiten genannt. `ResolveIpNetEntry2` wird bewusst nicht benutzt: er verwirft den Eintrag und sendet ARP |

### WLAN-Abfragen ohne Standortfreigabe (Windows 11 24H2)

Seit der ersten Funktionsversion nach Herbst 2024 (24H2) brauchen laut Microsoft
(„Changes to API behavior for Wi-Fi access and location“) eine Standortfreigabe und liefern sonst
`ERROR_ACCESS_DENIED`:

- `WlanGetAvailableNetworkList`, `WlanGetNetworkBssList`, `WlanScan`
- `WlanQueryInterface` mit `wlan_intf_opcode_current_connection` (SSID/BSSID der Verbindung)
- `WlanRegisterNotification` mit Quelle `WLAN_NOTIFICATION_SOURCE_MSM`
- WinRT `Windows.Devices.WiFi` und WLAN-Daten aus `NetworkInformation.GetLanIdentifiers`

Ohne Freigabe weiter nutzbar (auf den Referenzseiten ohne Berechtigungshinweis, von Microsoft
aber nicht ausdrücklich bestätigt): IP-Hilfe (`GetIpForwardTable2`, `GetIpNetTable2`,
`GetAdaptersAddresses`) und `NotifyIpInterfaceChange`. Für
`WlanConnectionProfileDetails.GetConnectedSsid`, das Microsoft für den WLAN-Namen empfiehlt, sagt
die Referenzseite nicht, ob eine Freigabe nötig ist.

**Entscheidung:** Der Windows-Client liest keinen WLAN-Namen. Die Kennung aus der Gateway-MAC
erkennt dasselbe Netz per LAN, Dock und WLAN ohne Standortdialog. Hinterlegte SSID-Netze greifen
auf Windows daher nicht; sie bleiben für macOS und Mobilgeräte nutzbar.

### Installer

`pnpm tauri build` erzeugt unter Windows ein MSI (WiX, Sprache de-DE). Code-Signing und
Tauri-Updater brauchen Schlüssel bzw. Zertifikat des Betreibers und sind noch offen.

### 👤 Prüfanleitung am echten Gerät

Vorher: App installieren, anmelden, Arbeitsnetz hinterlegen. Nach jedem Schritt im
Tagesprotokoll prüfen.

1. **Kaltstart:** Rechner ausschalten, einschalten, nach mindestens 5 min das Protokoll öffnen.
   Erwartung: „Hochgefahren“ mit der Einschaltzeit (nicht der Anmeldezeit).
2. **Schnellstart:** Schnellstart aktiv lassen (Standard), „Herunterfahren“, wieder einschalten.
   Erwartung wie 1, Einschaltzeit = jetzt, nicht der letzte Kaltstart. In der Ereignisanzeige
   (System, Quelle Kernel-Boot, ID 27) den `BootType` notieren.
3. **Ruhezustand:** „Ruhezustand“ wählen, wieder einschalten. Erwartung: **kein** neues
   „Hochgefahren“; die Zeit dazwischen ist Standby. `BootType` notieren (erwartet 2).
4. **Herunterfahren 17:00:** Erwartung „Heruntergefahren“ 17:00, Ende 17:05.
5. **Neustart:** Erwartung „Neustart“, kein Arbeitsende, Sitzung läuft durch.
6. **Windows-Update mit Neustart:** Erwartung „Neustart“ mit Update-Kennzeichen, kein
   Arbeitsende. In der Ereignisanzeige Ereignis 1074 (Quelle User32) mit Prozess, Grund-Code und
   Art notieren.
7. **Abmelden** und wieder anmelden. Erwartung: kein Ereignis, kein Arbeitsende.
8. **Sperren** (Win+L) 20 min. Erwartung: Pause von 20 min.
9. **Deckel zu 1 h** (Gerät mit modernem Standby und eines mit S3, falls vorhanden).
   Erwartung: Pause von 1 h.
10. **Deckel zu über Nacht** (inkl. automatischem Ruhezustand). Erwartung: Sitzungsende am Abend.
11. **LAN am Dock:** WLAN aus, Dock anstecken. Erwartung: Arbeitsnetz erkannt (Quelle LAN);
    Dock ab → „Netz getrennt“.
12. **Absturz:** Strom trennen bzw. lange Ein/Aus drücken. Erwartung: kein „Heruntergefahren“,
    Ende bei der letzten Aktivität.

Abweichungen bitte mit Windows-Version (`winver`) und den notierten Ereigniswerten melden.
