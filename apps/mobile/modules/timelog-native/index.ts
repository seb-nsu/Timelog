// Einstieg des lokalen Expo-Moduls. Ohne nativen Teil (Jest, Web, Expo Go) liefert
// `loadTimelogNative` eine Variante ohne Hintergrund-Erkennung; die App läuft dann mit
// manuellem Start/Stopp weiter.
import { type NativeModule, requireOptionalNativeModule } from 'expo';
import type {
  Capabilities,
  CurrentNetwork,
  DetectionStatus,
  GeofenceStatus,
  NativeConfig,
  NativeQueue,
  PermissionResult,
  TimelogNativeApi,
  WidgetState,
} from './src/types';

export type * from './src/types';

type Events = { onChange: () => void };

declare class TimelogNativeModule extends NativeModule<Events> {
  capabilities(): Promise<Capabilities>;
  configure(configJson: string): Promise<void>;
  status(): Promise<DetectionStatus>;
  currentNetwork(): Promise<CurrentNetwork>;
  checkNow(): Promise<void>;
  /** JSON von NativeQueue */
  drain(): Promise<string>;
  acknowledge(eventIds: string[], spansJson: string): Promise<void>;
  requestSsidPermission(): Promise<PermissionResult>;
  isIgnoringBatteryOptimizations(): Promise<boolean>;
  openBatterySettings(): Promise<void>;
  manufacturer(): Promise<string>;
  geofenceStatus(): Promise<GeofenceStatus>;
  enableGeofenceHere(radiusMeters: number, engine: string): Promise<GeofenceStatus>;
  disableGeofence(): Promise<void>;
  updateWidget(stateJson: string): Promise<void>;
}

/** Ohne natives Modul: keine automatische Erkennung, alles Übrige funktioniert. */
export const unavailableNative: TimelogNativeApi = {
  capabilities: () =>
    Promise.resolve({
      platform: 'none',
      networkDetection: false,
      ssidOption: false,
      geofence: false,
      shortcuts: false,
      widget: false,
      batteryOptimization: false,
    }),
  configure: () => Promise.resolve(),
  status: () => Promise.resolve({ armed: false, connected: false, lastCheck: null }),
  currentNetwork: () =>
    Promise.resolve({
      fingerprint: null,
      transport: 'none',
      ssid: null,
      bssid: null,
      matchedNetworkId: null,
    }),
  checkNow: () => Promise.resolve(),
  drain: () => Promise.resolve({ events: [], spans: [] }),
  acknowledge: () => Promise.resolve(),
  requestSsidPermission: () => Promise.resolve('unavailable'),
  isIgnoringBatteryOptimizations: () => Promise.resolve(true),
  openBatterySettings: () => Promise.resolve(),
  manufacturer: () => Promise.resolve(''),
  geofenceStatus: () =>
    Promise.resolve({ active: false, engine: null, permission: 'unavailable', inside: null }),
  enableGeofenceHere: () =>
    Promise.resolve({ active: false, engine: null, permission: 'unavailable', inside: null }),
  disableGeofence: () => Promise.resolve(),
  updateWidget: () => Promise.resolve(),
  addChangeListener: () => ({ remove: () => undefined }),
};

function wrap(m: TimelogNativeModule): TimelogNativeApi {
  return {
    capabilities: () => m.capabilities(),
    configure: (config: NativeConfig) => m.configure(JSON.stringify(config)),
    status: () => m.status(),
    currentNetwork: () => m.currentNetwork(),
    checkNow: () => m.checkNow(),
    drain: async () => JSON.parse(await m.drain()) as NativeQueue,
    acknowledge: (eventIds, spans) => m.acknowledge(eventIds, JSON.stringify(spans)),
    requestSsidPermission: () => m.requestSsidPermission(),
    isIgnoringBatteryOptimizations: () => m.isIgnoringBatteryOptimizations(),
    openBatterySettings: () => m.openBatterySettings(),
    manufacturer: () => m.manufacturer(),
    geofenceStatus: () => m.geofenceStatus(),
    enableGeofenceHere: (radius, engine) => m.enableGeofenceHere(radius, engine),
    disableGeofence: () => m.disableGeofence(),
    updateWidget: (state: WidgetState) => m.updateWidget(JSON.stringify(state)),
    addChangeListener: (listener) => m.addListener('onChange', listener),
  };
}

export function loadTimelogNative(): TimelogNativeApi {
  const m = requireOptionalNativeModule<TimelogNativeModule>('TimelogNative');
  return m ? wrap(m) : unavailableNative;
}
