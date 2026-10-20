// Schnittstelle des nativen Moduls (Kotlin/Swift, Expo Modules API).
// Das Modul erzeugt nur Ereignisse und Aktiv-Spannen; Arbeitszeit berechnet ausschließlich
// @timelog/rules. Es speichert und sendet weder Koordinaten noch fremde WLAN-Namen.
import type { EventSource } from '@timelog/rules';

/** Ereignis, das das native Modul selbst erzeugt hat (auch bei beendeter App). */
export interface NativeEvent {
  id: string;
  type: 'net_connected' | 'net_lost' | 'manual_start' | 'manual_end';
  source: EventSource;
  /** UTC, ISO 8601 */
  ts: string;
  /** IANA-Zeitzone des Geräts zum Ereigniszeitpunkt */
  tz: string;
  createdAt: string;
  /** ID des hinterlegten Arbeitsnetzes (vom Server), falls bekannt */
  networkId?: string;
}

/** Aktiv-Spanne „im Arbeitsnetz“ dieses Handys. */
export interface NativeSpan {
  id: string;
  start: string;
  end: string;
  open: boolean;
}

export interface NativeQueue {
  events: NativeEvent[];
  spans: NativeSpan[];
}

/** Arbeitsnetz, wie es der Server liefert (nur HMACs, keine Klartext-Kennungen). */
export interface NativeWorkNetwork {
  id: string;
  scope: 'user' | 'org';
  kind: 'ssid' | 'fingerprint' | 'geofence';
  ssid?: string;
  bssidHmac?: string;
  fingerprintHmac?: string;
}

export interface NativeConfig {
  /** Automatische Erkennung über Arbeitsnetz (Einstellung triggers.network). */
  detection: boolean;
  /** WLAN-Name zusätzlich prüfen (nur Android, nur falls im Build aktiviert und erlaubt). */
  ssid: boolean;
  networks: NativeWorkNetwork[];
  /** HMAC-Schlüssel (Base64) aus GET /networks */
  keys: { user: string; org?: string };
}

export interface CurrentNetwork {
  /** Netzwerk-Kennung im Klartext, nur für „Aktuelles Netz übernehmen“ (Server speichert HMAC). */
  fingerprint: string | null;
  transport: 'wifi' | 'ethernet' | 'other' | 'none';
  /** Nur mit aktivierter Option „WLAN-Name“ und Standortfreigabe, sonst null. */
  ssid: string | null;
  bssid: string | null;
  /** Treffer mit einem hinterlegten Arbeitsnetz (ID), sonst null. */
  matchedNetworkId: string | null;
}

export interface Capabilities {
  platform: 'android' | 'ios' | 'none';
  /** Android: Netzwerk-Callback mit PendingIntent und WorkManager-Prüfung. */
  networkDetection: boolean;
  /** Android: WLAN-Name ist im Build aktiviert (Standortberechtigung im Manifest). */
  ssidOption: boolean;
  /** iOS: Geofence für das Arbeitsende. */
  geofence: boolean;
  /** iOS: App Intent „Arbeitsnetz verbunden“ für Kurzbefehle. */
  shortcuts: boolean;
  widget: boolean;
  /** Android: Hinweis auf Akkuoptimierung sinnvoll. */
  batteryOptimization: boolean;
}

export type PermissionResult = 'granted' | 'denied' | 'undetermined' | 'unavailable';

export interface GeofenceStatus {
  active: boolean;
  engine: 'monitor' | 'region' | null;
  permission: 'always' | 'whenInUse' | 'denied' | 'undetermined' | 'unavailable';
  /** Zuletzt gemeldeter Zustand (innerhalb des Bereichs), null = unbekannt. */
  inside: boolean | null;
}

export interface WidgetState {
  running: boolean;
  /** Beginn der laufenden Sitzung (UTC) */
  since?: string;
  netMinutes: number;
  /** Fertige Texte in der App-Sprache */
  title: string;
  subtitle: string;
  startLabel: string;
  stopLabel: string;
  tz: string;
}

export interface DetectionStatus {
  /** Netzwerk-Callback bzw. Geofence ist aktiv */
  armed: boolean;
  /** Zuletzt erkannt: im Arbeitsnetz */
  connected: boolean;
  /** Letzte Prüfung (WorkManager, App-Start) */
  lastCheck: string | null;
}

export interface TimelogNativeApi {
  capabilities(): Promise<Capabilities>;
  configure(config: NativeConfig): Promise<void>;
  status(): Promise<DetectionStatus>;
  currentNetwork(): Promise<CurrentNetwork>;
  /** Sofort prüfen (wie der 15-Minuten-Takt). */
  checkNow(): Promise<void>;
  /** Vom nativen Teil erzeugte, noch nicht abgeholte Ereignisse und Spannen. */
  drain(): Promise<NativeQueue>;
  /** Abgeholte Ereignisse löschen; abgeschlossene Spannen mit diesem Ende löschen. */
  acknowledge(eventIds: string[], spans: { id: string; end: string }[]): Promise<void>;
  requestSsidPermission(): Promise<PermissionResult>;
  isIgnoringBatteryOptimizations(): Promise<boolean>;
  openBatterySettings(): Promise<void>;
  manufacturer(): Promise<string>;
  geofenceStatus(): Promise<GeofenceStatus>;
  /** Fragt bei Bedarf nach „Immer“-Standort und überwacht den aktuellen Ort als Bereich. */
  enableGeofenceHere(radiusMeters: number, engine: 'monitor' | 'region'): Promise<GeofenceStatus>;
  disableGeofence(): Promise<void>;
  updateWidget(state: WidgetState): Promise<void>;
  /** Meldet neue native Ereignisse, solange die App läuft. */
  addChangeListener(listener: () => void): { remove: () => void };
}
