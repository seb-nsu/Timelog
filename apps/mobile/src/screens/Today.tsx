// Heute: Status, Netto, Saldo, ArbZG-Hinweise, Start/Stopp, alles zu Prüfende und Übertragungsstand.
import {
  formatBalance,
  formatClock,
  formatMinutes,
  periodDays,
  todaySummary,
} from '@timelog/app-core';
import { addDays, weekday } from '@timelog/rules';
import { Body, Big, Button, Notice, Row, Screen, Section } from '../ui/components';
import { useMobile } from '../ui/context';
import { ReviewSection } from './Review';

export function TodayScreen() {
  const { core, state, days, now, t } = useMobile();
  const tz = state.timezone;
  const today = todaySummary(days, now, tz);
  const monday = addDays(today.date, -((weekday(today.date) + 6) % 7));
  const week = periodDays(days, state.profile, monday, addDays(monday, 6), today.date);
  const net = formatMinutes(today.netMinutes);

  return (
    <Screen title={t.m('today.title')}>
      <Section>
        <Body>{today.running ? t.t('status.running') : t.t('status.stopped')}</Body>
        {today.running && today.since ? (
          <Body muted>{t.m('today.since', { time: formatClock(today.since, tz) })}</Body>
        ) : null}
        <Big label={`${t.m('today.net')}: ${net}`}>{net}</Big>
        <Row label={t.m('today.breaks')} value={formatMinutes(today.breakMinutes)} />
        <Row label={t.m('today.week')} value={formatMinutes(week.netMinutes)} />
        <Row label={t.m('today.balance')} value={formatBalance(today.balanceMinutes)} />
        {today.day && today.day.breakTopUpMin > 0 ? (
          <Notice tone="warning">{t.m('today.topUp', { minutes: today.day.breakTopUpMin })}</Notice>
        ) : null}
        <Button
          testID="toggle-work"
          label={today.running ? t.t('action.stop') : t.t('action.start')}
          hint={today.running ? t.m('today.stopHint') : t.m('today.startHint')}
          variant={today.running ? 'danger' : 'primary'}
          onPress={() => core.manual(today.running ? 'manual_end' : 'manual_start')}
        />
      </Section>

      {today.day && today.day.warnings.length > 0 ? (
        <Section title={t.m('today.warnings')}>
          {today.day.warnings.map((w) => (
            <Notice key={w} tone="warning">
              {t.warning(w)}
            </Notice>
          ))}
        </Section>
      ) : null}

      <ReviewSection />

      <Section>
        <Body muted>
          {state.detection.armed
            ? `${t.m('today.detectionOn')} · ${
                state.detection.connected ? t.m('today.inNetwork') : t.m('today.notInNetwork')
              }`
            : t.m('today.detectionOff')}
        </Body>
        <SyncLine />
      </Section>
    </Screen>
  );
}

function SyncLine() {
  const { core, state, t, go } = useMobile();
  const tz = state.timezone;
  const s = state.sync;
  const lines: { text: string; tone: 'info' | 'warning' | 'error' }[] = [];
  if (s.state === 'localOnly') lines.push({ text: t.m('today.localOnly'), tone: 'info' });
  if (s.state === 'ok') {
    lines.push({
      text: state.pending > 0 ? t.t('sync.pending', { count: state.pending }) : t.t('sync.ok'),
      tone: 'info',
    });
  }
  if (s.state === 'offline') {
    lines.push({
      text: `${t.t('sync.offline')} · ${t.m('today.retryAt', { time: formatClock(s.retryAt, tz) })}`,
      tone: 'warning',
    });
  }
  if (s.state === 'needsLogin') lines.push({ text: t.t('sync.needsLogin'), tone: 'error' });
  if (s.state === 'idle' && state.pending > 0) {
    lines.push({ text: t.t('sync.pending', { count: state.pending }), tone: 'info' });
  }
  if (state.rejected > 0) {
    lines.push({ text: t.m('today.rejected', { count: state.rejected }), tone: 'error' });
  }
  return (
    <>
      {lines.map((l) => (
        <Notice key={l.text} tone={l.tone}>
          {l.text}
        </Notice>
      ))}
      {state.account === 'loggedIn' ? (
        <Button variant="secondary" label={t.t('sync.now')} onPress={() => core.sync(true)} />
      ) : null}
      {s.state === 'needsLogin' ? (
        <Button
          label={t.m('settings.login')}
          onPress={() => {
            go({ name: 'setup' });
          }}
        />
      ) : null}
    </>
  );
}
