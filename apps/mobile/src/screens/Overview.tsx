// Woche/Monat mit Netto, Soll und Saldo; Export und Abwesenheiten.
import { formatBalance, formatDate, formatMinutes, periodDays } from '@timelog/app-core';
import { addDays, localDate, weekday } from '@timelog/rules';
import { useState } from 'react';
import { LOOKBACK_DAYS } from '../core/core';
import { Body, Button, Choice, Notice, Row, Screen, Section } from '../ui/components';
import { useMobile } from '../ui/context';

type Mode = 'week' | 'month';

export function periodRange(
  today: string,
  mode: Mode,
  offset: number,
): { from: string; to: string } {
  if (mode === 'week') {
    const monday = addDays(today, -((weekday(today) + 6) % 7) + offset * 7);
    return { from: monday, to: addDays(monday, 6) };
  }
  const [y, m] = today.split('-').map(Number) as [number, number];
  const first = new Date(Date.UTC(y, m - 1 + offset, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0));
  return { from: first.toISOString().slice(0, 10), to: last.toISOString().slice(0, 10) };
}

export function OverviewScreen() {
  const { core, state, days, now, t, go, actions } = useMobile();
  const [mode, setMode] = useState<Mode>('week');
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const today = localDate(Date.parse(now), state.timezone);
  const { from, to } = periodRange(today, mode, offset);
  const summary = periodDays(days, state.profile, from, to, today);
  const earliest = addDays(today, -LOOKBACK_DAYS);

  const share = async (format: 'csv' | 'pdf') => {
    setError(null);
    try {
      const blob = await core.exportReport(from, to, format);
      await actions.shareFile(
        `timelog-${from}-${to}.${format}`,
        format === 'csv' ? 'text/csv' : 'application/pdf',
        blob,
      );
    } catch {
      setError(t.m('common.error'));
    }
  };

  return (
    <Screen title={t.m('overview.title')}>
      <Choice<Mode>
        label={t.m('overview.title')}
        value={mode}
        onChange={(m) => {
          setMode(m);
          setOffset(0);
        }}
        options={[
          { value: 'week', label: t.m('overview.week') },
          { value: 'month', label: t.m('overview.month') },
        ]}
      />
      <Section title={`${formatDate(from, t.tag)} – ${formatDate(to, t.tag)}`}>
        <Row label={t.m('overview.net')} value={formatMinutes(summary.netMinutes)} />
        <Row label={t.m('overview.target')} value={formatMinutes(summary.targetMinutes)} />
        {summary.absenceMinutes > 0 ? (
          <Row label={t.m('overview.absences')} value={formatMinutes(summary.absenceMinutes)} />
        ) : null}
        <Row label={t.m('overview.balance')} value={formatBalance(summary.balanceMinutes)} />
        <Button
          variant="secondary"
          label={t.m('overview.prev')}
          disabled={from <= earliest}
          onPress={() => {
            setOffset(offset - 1);
          }}
        />
        <Button
          variant="secondary"
          label={t.m('overview.next')}
          disabled={offset >= 0}
          onPress={() => {
            setOffset(offset + 1);
          }}
        />
      </Section>

      <Section>
        {summary.days.map((d) => (
          <Row
            key={d.date}
            label={`${formatDate(d.date, t.tag)}${d.warnings.length > 0 ? ' ⚠' : ''}`}
            value={`${formatMinutes(d.netMinutes + d.absenceMinutes)} / ${formatMinutes(d.targetMinutes)}`}
            onPress={() => {
              go({ name: 'log', date: d.date });
            }}
          />
        ))}
      </Section>

      <Button
        variant="secondary"
        label={t.t('nav.week')}
        onPress={() => {
          go(mode === 'week' ? { name: 'week', date: from } : { name: 'week' });
        }}
      />
      <Button
        variant="secondary"
        label={t.m('overview.absences')}
        onPress={() => {
          go({ name: 'absences' });
        }}
      />
      <Button
        variant="secondary"
        label={t.m('overview.leave')}
        onPress={() => {
          go({ name: 'leave' });
        }}
      />
      <Button
        variant="secondary"
        label={t.t('nav.reports')}
        onPress={() => {
          go({ name: 'reports' });
        }}
      />
      <Section title={t.m('overview.export')}>
        {state.account === 'loggedIn' ? (
          <>
            <Button variant="secondary" label={t.m('overview.csv')} onPress={() => share('csv')} />
            <Button variant="secondary" label={t.m('overview.pdf')} onPress={() => share('pdf')} />
          </>
        ) : (
          <Body muted>{t.m('overview.exportNeedsAccount')}</Body>
        )}
        {error ? <Notice tone="error">{error}</Notice> : null}
      </Section>
    </Screen>
  );
}
