// Einstieg der Handy-App: Kern laden, Plattformdienste starten, Oberfläche anzeigen.
import { pickLocale, reviewItems, todaySummary } from '@timelog/app-core';
import { registerRootComponent } from 'expo';
import Constants from 'expo-constants';
import { getLocales } from 'expo-localization';
import { StatusBar } from 'expo-status-bar';
import { createElement, useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { App } from './src/App';
import { registerBackgroundSync } from './src/background';
import type { MobileCore } from './src/core/core';
import { planReminders } from './src/core/reminders';
import { widgetState } from './src/core/widget';
import { shareFile } from './src/files';
import {
  configureNotifications,
  requestNotifications,
  scheduleReminders,
  startPush,
} from './src/notifications';
import { getCore } from './src/platform';
import { setDefaultServer } from './src/screens/forms';
import { createMobileTranslator } from './src/i18n';
import type { MobileProviderProps, PlatformActions, Route } from './src/ui/context';

const locale = pickLocale(getLocales()[0].languageTag);
const translator = createMobileTranslator(locale);

/** Ziele aus angetippten Benachrichtigungen an die Oberfläche weiterreichen. */
const routes = (() => {
  let target: ((route: Route) => void) | undefined;
  let pending: Route | undefined;
  return {
    emit: (route: Route) => {
      if (target) target(route);
      else pending = route;
    },
    listen: (go: (route: Route) => void) => {
      target = go;
      if (pending) go(pending);
      pending = undefined;
      return () => {
        target = undefined;
      };
    },
  };
})();
const extra = Constants.expoConfig?.extra as { defaultServer?: unknown } | undefined;
if (typeof extra?.defaultServer === 'string') setDefaultServer(extra.defaultServer);

function Root() {
  const [core, setCore] = useState<MobileCore | null>(null);

  useEffect(() => {
    let active = true;
    void getCore().then((c) => {
      if (active) setCore(c);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!core) return;
    core.start();
    void core.ingestNative().then(() => core.sync());
    void registerBackgroundSync().catch(() => undefined);
    const stopPush = startPush(core, translator, routes.emit);
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') void core.ingestNative().then(() => core.sync());
    });
    return () => {
      sub.remove();
      stopPush();
      core.stop();
    };
  }, [core]);

  const onUpdate = useCallback<NonNullable<MobileProviderProps['onUpdate']>>(
    ({ state, days, now, t }) => {
      if (!core) return;
      const today = todaySummary(days, now, state.timezone);
      void core.updateWidget(widgetState(today, t, state.timezone));
      const plan = planReminders({
        today,
        reviewCount: reviewItems(days).length,
        notifications: state.settings.notifications,
        now,
        tz: state.timezone,
      });
      void configureNotifications(t)
        .then(() => scheduleReminders(plan, t))
        .catch(() => undefined);
    },
    [core],
  );

  if (!core) return null;
  const actions: PlatformActions = {
    shareFile,
    requestNotifications: () => requestNotifications(core, locale),
  };
  return [
    createElement(StatusBar, { key: 'bar', style: 'auto' }),
    createElement(App, {
      key: 'app',
      core,
      locale,
      actions,
      onUpdate,
      externalRoutes: routes.listen,
    }),
  ];
}

registerRootComponent(Root);
