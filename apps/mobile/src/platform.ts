// Verdrahtung mit Expo: SQLite, sicherer Speicher (Keychain/Keystore), Gerätedaten, natives Modul.
// Eine Instanz je Prozess – die App und der Hintergrund-Task teilen sie.
import { uuid } from 'expo';
import * as Crypto from 'expo-crypto';
import * as Device from 'expo-device';
import { pickLocale } from '@timelog/app-core';
import { getCalendars, getLocales } from 'expo-localization';
import * as SecureStore from 'expo-secure-store';
import * as SQLite from 'expo-sqlite';
import { Platform } from 'react-native';
import { loadTimelogNative } from '../modules/timelog-native';
import { MobileCore, type SecureStorage } from './core/core';
import { type SqlDatabase, Store } from './core/store';

// Nach dem ersten Entsperren lesbar, damit der Sync im Hintergrund das Refresh-Token findet;
// nie in Backups oder auf andere Geräte übertragen.
const secureOptions: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

const secure: SecureStorage = {
  getItem: (key) => SecureStore.getItemAsync(key, secureOptions),
  setItem: (key, value) => SecureStore.setItemAsync(key, value, secureOptions),
  deleteItem: (key) => SecureStore.deleteItemAsync(key, secureOptions),
};

function sqlAdapter(db: SQLite.SQLiteDatabase): SqlDatabase {
  return {
    execAsync: (sql) => db.execAsync(sql),
    runAsync: (sql, params) => db.runAsync(sql, params),
    getAllAsync: <T>(sql: string, params: (string | number | null)[]) =>
      db.getAllAsync<T>(sql, params),
    withTransactionAsync: (task) => db.withTransactionAsync(task),
  };
}

export function deviceTimezone(): string {
  return getCalendars()[0].timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
}

let core: Promise<MobileCore> | undefined;

export function getCore(): Promise<MobileCore> {
  core ??= (async () => {
    const db = await SQLite.openDatabaseAsync('timelog.db');
    await db.execAsync('PRAGMA journal_mode = WAL;');
    const store = await Store.open(sqlAdapter(db));
    return new MobileCore({
      store,
      secure,
      native: loadTimelogNative(),
      uuid: () => uuid.v4(),
      timezone: deviceTimezone,
      locale: pickLocale(getLocales()[0].languageTag),
      crypto: {
        sha256: async (data) =>
          new Uint8Array(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, data)),
        randomBytes: (n) => Crypto.getRandomBytes(n),
      },
      device: {
        os: `${Platform.OS} ${Device.osVersion ?? ''}`.trim().slice(0, 50),
        name: (Device.deviceName ?? Device.modelName ?? 'Handy').slice(0, 100),
      },
    });
  })();
  return core;
}
