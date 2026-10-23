// Expo-Konfiguration. Alle Werte, die je Installation abweichen, kommen aus Umgebungsvariablen
// (siehe .env.example im Wurzelverzeichnis); Secrets gehören nicht hierher.
import type { ConfigContext, ExpoConfig } from 'expo/config';

const env = (name: string): string | undefined =>
  (process.env as Record<string, string | undefined>)[name];

const bundleId = env('TIMELOG_BUNDLE_ID') ?? 'de.timelog.mobile';
const appGroup = `group.${bundleId}`;

// WLAN-Name auf Android ist optional und standardmäßig aus: nur mit diesem Schalter landen die
// Standortberechtigungen im Manifest (und es braucht die Play-Erklärung, docs/MOBILE.md).
const wifiName = env('TIMELOG_ANDROID_WIFI_NAME') === '1';
const locationPermissions = [
  'android.permission.ACCESS_FINE_LOCATION',
  'android.permission.ACCESS_COARSE_LOCATION',
  'android.permission.ACCESS_BACKGROUND_LOCATION',
];

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: 'TimeLog',
  slug: 'timelog',
  scheme: 'timelog',
  version: '0.1.0',
  orientation: 'default',
  userInterfaceStyle: 'automatic',
  ios: {
    bundleIdentifier: bundleId,
    supportsTablet: true,
    entitlements: { 'com.apple.security.application-groups': [appGroup] },
    infoPlist: { ITSAppUsesNonExemptEncryption: false },
  },
  android: {
    package: bundleId,
    ...(env('TIMELOG_GOOGLE_SERVICES_FILE')
      ? { googleServicesFile: env('TIMELOG_GOOGLE_SERVICES_FILE') }
      : {}),
    permissions: [
      'android.permission.ACCESS_NETWORK_STATE',
      'android.permission.ACCESS_WIFI_STATE',
      'android.permission.RECEIVE_BOOT_COMPLETED',
      'android.permission.POST_NOTIFICATIONS',
      ...(wifiName ? locationPermissions : []),
    ],
    // Dateien teilt die App über das System-Teilen-Menü; Speicherzugriff ist nicht nötig.
    blockedPermissions: [
      'android.permission.READ_EXTERNAL_STORAGE',
      'android.permission.WRITE_EXTERNAL_STORAGE',
      ...(wifiName ? [] : locationPermissions),
    ],
  },
  plugins: [
    'expo-dev-client',
    'expo-localization',
    'expo-sqlite',
    'expo-secure-store',
    'expo-background-task',
    [
      'expo-notifications',
      {
        mode: env('TIMELOG_APNS_MODE') === 'production' ? 'production' : 'development',
        enableBackgroundRemoteNotifications: false,
      },
    ],
    [
      'expo-build-properties',
      { android: { minSdkVersion: 24 }, ios: { deploymentTarget: '16.4' } },
    ],
    '@bacons/apple-targets',
    ['./plugins/withTimelog', { appGroup }],
  ],
  extra: {
    defaultServer: env('TIMELOG_DEFAULT_SERVER') ?? '',
    ...(env('EAS_PROJECT_ID') ? { eas: { projectId: env('EAS_PROJECT_ID') } } : {}),
  },
});
