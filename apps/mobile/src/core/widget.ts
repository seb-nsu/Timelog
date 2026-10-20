// Zustand für das Startbildschirm-Widget (Android Glance, iOS WidgetKit) aus dem berechneten Tag.
import { type TodaySummary, formatClock, formatMinutes } from '@timelog/app-core';
import type { WidgetState } from '../../modules/timelog-native';
import type { MobileTranslator } from '../i18n';

export function widgetState(today: TodaySummary, t: MobileTranslator, tz: string): WidgetState {
  const net = formatMinutes(today.netMinutes);
  return {
    running: today.running,
    ...(today.since ? { since: today.since } : {}),
    netMinutes: today.netMinutes,
    title: today.running ? t.m('widget.running') : t.m('widget.stopped'),
    subtitle:
      today.running && today.since
        ? `${t.m('today.since', { time: formatClock(today.since, tz) })} · ${t.m('widget.net', { net })}`
        : t.m('widget.net', { net }),
    startLabel: t.t('action.start'),
    stopLabel: t.t('action.stop'),
    tz,
  };
}
