// Zeiten: Woche/Monat mit Netto, Soll und Saldo, Tagesliste, „Woche bestätigen“ und Export.
// Ersetzt Übersicht und Wochenrückblick; die Auswertung erscheint nur mit Zusatzfunktionen.
import {
  formatBalance,
  formatDate,
  formatMinutes,
  periodDays,
  weekSummary,
} from '@timelog/app-core';
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

/** Wochen zwischen dem Montag von `date` und dem von `today` (0 = diese Woche). */
function weekOffset(today: string, date: string): number {
  const monday = (d: string) => addDays(d, -((weekday(d) + 6) % 7));
  return Math.round((Date.parse(monday(date)) - Date.parse(monday(today))) / (7 * 86_400_000));
}

export function OverviewScreen({ date }: { date?: string }) {
  const { core, state, days, now, t, go, actions } = useMobile();
  const today = localDate(Date.parse(now), state.timezone);
  const [mode, setMode] = useState<Mode>('week');
  const [offset, setOffset] = useState(date ? weekOffset(today, date) : 0);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const { from, to } = periodRange(today, mode, offset);
  const week = mode === 'week' ? weekSummary(days, state.profile, from, today) : undefined;
  const extras = state.settings.projects || state.settings.homeOffice;

  const confirm = async (dates: string[]) => {
    setBusy(true);
    setMsg(null);
    try {
      const count = await core.confirmDays(days, dates);
      setMsg({ tone: 'success', text: t.t('week.confirmed', { count }) });
    } catch {
      setMsg({ tone: 'error', text: t.m('common.error') });
    } finally {
      setBusy(false);
    }
  };
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
          setMsg(null);
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
            setMsg(null);
          }}
        />
        <Button
          variant="secondary"
          label={t.m('overview.next')}
          disabled={offset >= 0}
          onPress={() => {
            setOffset(offset + 1);
            setMsg(null);
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

      {week && week.legalHints.length > 0 ? (
        <Section title={t.t('week.hints')}>
          {week.legalHints.map((h) => (
            <Notice key={h.date} tone="warning">
              {`${formatDate(h.date, t.tag)}: ${h.warnings.map((w) => t.warning(w)).join(', ')}`}
            </Notice>
          ))}
        </Section>
      ) : null}

      {week ? (
        week.confirmableDays.length === 0 ? (
          <Body muted>{t.t('week.nothing')}</Body>
        ) : (
          <Button
            label={t.t('week.confirm')}
            hint={t.t('week.confirmHint', { count: week.confirmableDays.length })}
            disabled={busy}
            onPress={() => confirm(week.confirmableDays)}
          />
        )
      ) : null}
      {msg ? <Notice tone={msg.tone}>{msg.text}</Notice> : null}

      {extras ? (
        <Button
          variant="secondary"
          label={t.t('nav.reports')}
          onPress={() => {
            go({ name: 'reports' });
          }}
        />
      ) : null}
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
