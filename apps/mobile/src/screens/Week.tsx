// Wochenrückblick: Summen aus dem Regelwerk, offene Tage, Hinweise zum ArbZG und
// „Woche bestätigen“ für alle unproblematischen Tage (Tage mit Prüfhinweisen bleiben offen).
import { formatBalance, formatDate, formatMinutes, weekSummary } from '@timelog/app-core';
import { addDays, localDate } from '@timelog/rules';
import { useState } from 'react';
import { LOOKBACK_DAYS } from '../core/core';
import { Body, Button, Notice, Row, Screen, Section } from '../ui/components';
import { useMobile } from '../ui/context';

type Msg = { tone: 'success' | 'error'; text: string } | null;

export function WeekScreen({ date: initial }: { date?: string }) {
  const { core, state, days, now, t, go } = useMobile();
  const today = localDate(Date.parse(now), state.timezone);
  const [date, setDate] = useState(initial ?? today);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const summary = weekSummary(days, state.profile, date, today);
  const { week } = summary;
  const earliest = addDays(today, -LOOKBACK_DAYS);

  const confirm = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const count = await core.confirmDays(days, summary.confirmableDays);
      setMsg({ tone: 'success', text: t.t('week.confirmed', { count }) });
    } catch {
      setMsg({ tone: 'error', text: t.m('common.error') });
    } finally {
      setBusy(false);
    }
  };

  const move = (delta: number) => {
    setDate(addDays(week.from, delta * 7));
    setMsg(null);
  };

  return (
    <Screen title={t.t('week.title')}>
      <Section
        title={t.t('week.range', {
          week: Number(week.id.slice(-2)),
          from: formatDate(week.from, t.tag),
          to: formatDate(week.to, t.tag),
        })}
      >
        <Row label={t.t('week.work')} value={`${formatMinutes(summary.workMinutes)} h`} />
        <Row label={t.t('week.net')} value={`${formatMinutes(summary.netMinutes)} h`} />
        <Row label={t.t('week.target')} value={`${formatMinutes(summary.targetMinutes)} h`} />
        {summary.absenceMinutes > 0 ? (
          <Row label={t.t('week.absences')} value={`${formatMinutes(summary.absenceMinutes)} h`} />
        ) : null}
        <Row label={t.t('week.balance')} value={`${formatBalance(summary.balanceMinutes)} h`} />
        <Button
          variant="secondary"
          label={t.t('week.prev')}
          disabled={week.from <= earliest}
          onPress={() => {
            move(-1);
          }}
        />
        <Button
          variant="secondary"
          label={t.t('week.next')}
          disabled={week.to >= today}
          onPress={() => {
            move(1);
          }}
        />
      </Section>

      <Section title={t.t('week.open')}>
        {summary.openDays.length === 0 ? (
          <Body muted>{t.t('week.openNone')}</Body>
        ) : (
          <>
            <Body muted>{t.t('week.openHint')}</Body>
            {summary.openDays.map((d) => {
              const day = days.find((x) => x.date === d);
              return (
                <Row
                  key={d}
                  label={t.t('week.openDay', { date: formatDate(d, t.tag) })}
                  value={(day?.warnings ?? []).map((w) => t.warning(w)).join(', ')}
                  onPress={() => {
                    go({ name: 'log', date: d });
                  }}
                />
              );
            })}
          </>
        )}
      </Section>

      <Section title={t.t('week.hints')}>
        {summary.legalHints.length === 0 ? (
          <Body muted>{t.t('week.hintsNone')}</Body>
        ) : (
          summary.legalHints.map((h) => (
            <Notice key={h.date} tone="warning">
              {`${formatDate(h.date, t.tag)}: ${h.warnings.map((w) => t.warning(w)).join(', ')}`}
            </Notice>
          ))
        )}
      </Section>

      {summary.confirmableDays.length === 0 ? (
        <Body muted>{t.t('week.nothing')}</Body>
      ) : (
        <Button
          label={t.t('week.confirm')}
          hint={t.t('week.confirmHint', { count: summary.confirmableDays.length })}
          disabled={busy}
          onPress={confirm}
        />
      )}
      {msg ? <Notice tone={msg.tone}>{msg.text}</Notice> : null}
    </Screen>
  );
}
