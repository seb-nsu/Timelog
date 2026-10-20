// Attrappe des nativen Moduls: Tests legen Ereignisse in die Warteschlange und lesen,
// was die App konfiguriert hat.
import type {
  Capabilities,
  CurrentNetwork,
  GeofenceStatus,
  NativeConfig,
  NativeEvent,
  NativeSpan,
  TimelogNativeApi,
  WidgetState,
} from '../modules/timelog-native';

export interface FakeNative extends TimelogNativeApi {
  queue: { events: NativeEvent[]; spans: NativeSpan[] };
  configs: NativeConfig[];
  widgets: WidgetState[];
  acks: { events: string[]; spans: { id: string; end: string }[] }[];
  network: CurrentNetwork;
  geofence: GeofenceStatus;
  batteryIgnored: boolean;
  calls: string[];
  fire: () => void;
}

export const ANDROID: Capabilities = {
  platform: 'android',
  networkDetection: true,
  ssidOption: false,
  geofence: false,
  shortcuts: false,
  widget: true,
  batteryOptimization: true,
};

export const IOS: Capabilities = {
  platform: 'ios',
  networkDetection: false,
  ssidOption: false,
  geofence: true,
  shortcuts: true,
  widget: true,
  batteryOptimization: false,
};

export function fakeNative(capabilities: Capabilities = ANDROID): FakeNative {
  const listeners = new Set<() => void>();
  const fake: FakeNative = {
    queue: { events: [], spans: [] },
    configs: [],
    widgets: [],
    acks: [],
    calls: [],
    network: {
      fingerprint: 'v4;gw=10.1.0.1;net=10.1.0.0/16;dns=10.1.0.10;dom=corp.example.com',
      transport: 'wifi',
      ssid: null,
      bssid: null,
      matchedNetworkId: null,
    },
    geofence: { active: false, engine: null, permission: 'undetermined', inside: null },
    batteryIgnored: false,
    fire: () => {
      for (const l of listeners) l();
    },
    capabilities: () => Promise.resolve(capabilities),
    configure: (config) => {
      fake.configs.push(config);
      return Promise.resolve();
    },
    status: () =>
      Promise.resolve({
        armed: fake.configs.at(-1)?.detection ?? false,
        connected: fake.network.matchedNetworkId !== null,
        lastCheck: null,
      }),
    currentNetwork: () => Promise.resolve(fake.network),
    checkNow: () => {
      fake.calls.push('checkNow');
      return Promise.resolve();
    },
    drain: () => Promise.resolve({ events: [...fake.queue.events], spans: [...fake.queue.spans] }),
    acknowledge: (events, spans) => {
      fake.acks.push({ events, spans });
      fake.queue.events = fake.queue.events.filter((e) => !events.includes(e.id));
      // wie nativ: eine offene Spanne gilt bis zur nächsten Verlängerung als abgeholt
      fake.queue.spans = fake.queue.spans.filter(
        (s) => !spans.some((a) => a.id === s.id && a.end === s.end),
      );
      return Promise.resolve();
    },
    requestSsidPermission: () => Promise.resolve('granted'),
    isIgnoringBatteryOptimizations: () => Promise.resolve(fake.batteryIgnored),
    openBatterySettings: () => {
      fake.calls.push('openBatterySettings');
      return Promise.resolve();
    },
    manufacturer: () => Promise.resolve('samsung'),
    geofenceStatus: () => Promise.resolve(fake.geofence),
    enableGeofenceHere: (radius, engine) => {
      fake.calls.push(`geofence:${String(radius)}:${engine}`);
      fake.geofence = { active: true, engine, permission: 'always', inside: true };
      return Promise.resolve(fake.geofence);
    },
    disableGeofence: () => {
      fake.calls.push('geofence:off');
      fake.geofence = { ...fake.geofence, active: false, engine: null, inside: null };
      return Promise.resolve();
    },
    updateWidget: (state) => {
      fake.widgets.push(state);
      return Promise.resolve();
    },
    addChangeListener: (l) => {
      listeners.add(l);
      return {
        remove: () => {
          listeners.delete(l);
        },
      };
    },
  };
  return fake;
}
