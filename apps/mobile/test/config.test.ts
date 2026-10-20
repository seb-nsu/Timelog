import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ConfigContext, ExpoConfig } from 'expo/config';

const root = join(__dirname, '..');

function loadConfig(env: Record<string, string>): ExpoConfig {
  const before = { ...process.env };
  Object.assign(process.env, env);
  let result: ExpoConfig | undefined;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('../app.config') as { default: (ctx: ConfigContext) => ExpoConfig };
    result = mod.default({ config: {} } as ConfigContext);
  });
  process.env = before;
  if (!result) throw new Error('keine Konfiguration');
  return result;
}

afterEach(() => {
  delete process.env.TIMELOG_ANDROID_WIFI_NAME;
});

describe('Native Konfiguration', () => {
  it('App und Widget teilen dieselbe TimelogShared.swift', () => {
    const app = readFileSync(join(root, 'modules/timelog-native/ios/TimelogShared.swift'), 'utf8');
    const widget = readFileSync(join(root, 'targets/widget/TimelogShared.swift'), 'utf8');
    expect(widget).toBe(app);
  });

  it('ohne Schalter keine Standortberechtigung auf Android', () => {
    const config = loadConfig({});
    expect(config.android?.permissions).not.toContain('android.permission.ACCESS_FINE_LOCATION');
    expect(config.android?.blockedPermissions).toContain(
      'android.permission.ACCESS_BACKGROUND_LOCATION',
    );
  });

  it('WLAN-Name nur mit TIMELOG_ANDROID_WIFI_NAME=1', () => {
    const config = loadConfig({ TIMELOG_ANDROID_WIFI_NAME: '1' });
    expect(config.android?.permissions).toContain('android.permission.ACCESS_FINE_LOCATION');
    expect(config.android?.blockedPermissions).not.toContain(
      'android.permission.ACCESS_FINE_LOCATION',
    );
  });

  it('App Group folgt der Bundle-ID', () => {
    const config = loadConfig({ TIMELOG_BUNDLE_ID: 'org.example.zeit' });
    expect(config.ios?.entitlements?.['com.apple.security.application-groups']).toEqual([
      'group.org.example.zeit',
    ]);
  });

  it('iOS ohne Hintergrundmodus „location“', () => {
    const plugin = readFileSync(join(root, 'plugins/withTimelog.js'), 'utf8');
    expect(plugin).not.toMatch(/UIBackgroundModes\s*[.=]/);
  });
});
