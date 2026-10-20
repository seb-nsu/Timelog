// Benachrichtigungen: lokale Erinnerungen (geplant aus src/core/reminders.ts) und das native
// Push-Token (FCM bzw. APNs, kein Expo-Push-Dienst) für POST /devices. Ungeprüft auf Gerät.
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import type { MobileCore } from './core/core';
import type { Reminder } from './core/reminders';
import type { MobileTranslator } from './i18n';

const CHANNEL = 'reminders';
const PREFIX = 'timelog-';

let configured = false;

export async function configureNotifications(t: MobileTranslator): Promise<void> {
  if (configured) return;
  configured = true;
  Notifications.setNotificationHandler({
    handleNotification: () =>
      Promise.resolve({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: false,
        shouldSetBadge: false,
      }),
  });
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync(CHANNEL, {
      name: t.m('notify.channel'),
      importance: Notifications.AndroidImportance.DEFAULT,
    });
  }
}

async function registerToken(core: MobileCore): Promise<void> {
  const token = await Notifications.getDevicePushTokenAsync();
  if (typeof token.data === 'string') await core.registerPushToken(token.data);
}

/** Nach Erlaubnis fragen und das Push-Token am Gerät hinterlegen. */
export async function requestNotifications(core: MobileCore): Promise<boolean> {
  const { granted } = await Notifications.requestPermissionsAsync();
  if (granted) await registerToken(core).catch(() => undefined);
  return granted;
}

/** Beim Start: Token erneut melden, falls bereits erlaubt; Token-Wechsel mitbekommen. */
export async function startPush(core: MobileCore): Promise<void> {
  const { granted } = await Notifications.getPermissionsAsync();
  if (!granted) return;
  await registerToken(core).catch(() => undefined);
  Notifications.addPushTokenListener((token) => {
    if (typeof token.data === 'string')
      void core.registerPushToken(token.data).catch(() => undefined);
  });
}

let lastPlan = '';

/** Geplante Erinnerungen ersetzen (nur wenn sich der Plan geändert hat). */
export async function scheduleReminders(plan: Reminder[], t: MobileTranslator): Promise<void> {
  const key = JSON.stringify(plan);
  if (key === lastPlan) return;
  lastPlan = key;
  const scheduled = await Notifications.getAllScheduledNotificationsAsync();
  for (const n of scheduled) {
    if (n.identifier.startsWith(PREFIX))
      await Notifications.cancelScheduledNotificationAsync(n.identifier);
  }
  for (const r of plan) {
    const text = t.reminder(r.kind);
    await Notifications.scheduleNotificationAsync({
      identifier: `${PREFIX}${r.kind}`,
      content: { title: text.title, body: text.body },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: new Date(r.at),
        ...(Platform.OS === 'android' ? { channelId: CHANNEL } : {}),
      },
    });
  }
}
