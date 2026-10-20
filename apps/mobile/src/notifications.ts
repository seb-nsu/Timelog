// Benachrichtigungen: lokale Erinnerungen (geplant aus src/core/reminders.ts), das native
// Push-Token (FCM bzw. APNs, kein Expo-Push-Dienst) für POST /devices und die Rückfragen per Push
// mit Aktionen („Stimmt“, „Korrigieren“). Ungeprüft auf Gerät, siehe docs/PUSH.md.
import { pickLocale } from '@timelog/app-core';
import { getLocales } from 'expo-localization';
import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';
import type { MobileCore } from './core/core';
import type { Reminder } from './core/reminders';
import { type MobileTranslator, createMobileTranslator } from './i18n';
import { getCore } from './platform';
import { answerFor, promptCategories } from './push';
import type { Route } from './ui/context';

const CHANNEL = 'reminders';
/** Kanal der Rückfragen; der Server setzt ihn in der FCM-Nachricht (channelId). */
export const PROMPT_CHANNEL = 'prompts';
const PREFIX = 'timelog-';
/** Android: „Stimmt“ bei beendeter oder Hintergrund-App */
export const PUSH_TASK = 'timelog-push-action';

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
    await Notifications.setNotificationChannelAsync(PROMPT_CHANNEL, {
      name: t.t('prompt.channel'),
      importance: Notifications.AndroidImportance.HIGH,
    });
  }
  const categories = promptCategories({
    yes: t.t('prompt.yes'),
    correct: t.t('prompt.correct'),
    open: t.t('prompt.open'),
  });
  for (const c of categories) {
    await Notifications.setNotificationCategoryAsync(c.identifier, c.actions);
  }
}

/**
 * Antwort auf eine Rückfrage ausführen. iOS erledigt „Stimmt“ nativ (auch ohne laufendes JS);
 * hier nur Android. Liefert das Ziel, falls die App etwas öffnen soll.
 */
export async function handleResponse(
  core: MobileCore,
  response: Notifications.NotificationResponse,
  reason: string,
): Promise<Route | undefined> {
  const { request } = response.notification;
  const answer = answerFor(response.actionIdentifier, request.content.data, request.identifier);
  if (answer.kind === 'open') return answer.route;
  if (answer.kind === 'confirm' && Platform.OS === 'android') {
    await core.answerPrompt(answer.data, answer.key, reason);
    await Notifications.dismissNotificationAsync(request.identifier).catch(() => undefined);
  }
  return undefined;
}

// Im Modul-Scope definiert, damit der Task auch bei beendeter App bereitsteht (Android).
TaskManager.defineTask<Notifications.NotificationTaskPayload>(PUSH_TASK, async ({ data }) => {
  if (!('actionIdentifier' in data)) return Notifications.BackgroundNotificationTaskResult.NoData;
  try {
    const core = await getCore();
    const t = createMobileTranslator(pickLocale(getLocales()[0].languageTag));
    await handleResponse(core, data, t.t('prompt.reason'));
    return Notifications.BackgroundNotificationTaskResult.NewData;
  } catch {
    return Notifications.BackgroundNotificationTaskResult.Failed;
  }
});

async function registerToken(core: MobileCore, locale: 'de' | 'en'): Promise<void> {
  const token = await Notifications.getDevicePushTokenAsync();
  if (typeof token.data === 'string') await core.registerPushToken(token.data, locale);
}

/** Nach Erlaubnis fragen und das Push-Token am Gerät hinterlegen. */
export async function requestNotifications(
  core: MobileCore,
  locale: 'de' | 'en',
): Promise<boolean> {
  const { granted } = await Notifications.requestPermissionsAsync();
  if (granted) await registerToken(core, locale).catch(() => undefined);
  return granted;
}

/**
 * Beim Start: Token erneut melden, falls bereits erlaubt; Token-Wechsel mitbekommen; Antworten
 * auf Rückfragen verarbeiten (auch die, mit der die App gestartet wurde).
 */
export function startPush(
  core: MobileCore,
  t: MobileTranslator,
  navigate: (route: Route) => void,
): () => void {
  const onResponse = (response: Notifications.NotificationResponse) => {
    void handleResponse(core, response, t.t('prompt.reason'))
      .then((route) => {
        if (route) navigate(route);
      })
      .catch(() => undefined);
  };
  const responses = Notifications.addNotificationResponseReceivedListener(onResponse);
  const last = Notifications.getLastNotificationResponse();
  if (last) {
    onResponse(last);
    Notifications.clearLastNotificationResponse();
  }
  let tokens: { remove: () => void } | undefined;
  void (async () => {
    if (Platform.OS === 'android') {
      await Notifications.registerTaskAsync(PUSH_TASK).catch(() => undefined);
    }
    const { granted } = await Notifications.getPermissionsAsync();
    if (!granted) return;
    await registerToken(core, t.locale).catch(() => undefined);
    tokens = Notifications.addPushTokenListener((token) => {
      if (typeof token.data === 'string')
        void core.registerPushToken(token.data, t.locale).catch(() => undefined);
    });
  })();
  return () => {
    responses.remove();
    tokens?.remove();
  };
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
