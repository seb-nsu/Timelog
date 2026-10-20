// Abwesenheiten: Urlaub, Krank, Feiertag, Sonstiges. Ohne Minutenangabe zählt die Sollzeit des Tages.
import { formatDate, formatMinutes, periodDays } from '@timelog/app-core';
import type { Absence, AbsenceKind } from '@timelog/rules';
import { ApiError } from '@timelog/shared';
import { useState } from 'react';
import { View } from 'react-native';
import { Body, Button, Choice, Field, Notice, Screen, Section } from '../ui/components';
import { useMobile } from '../ui/context';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const KINDS: AbsenceKind[] = ['vacation', 'sick', 'holiday', 'other'];
const DAY_MS = 86_400_000;

/** Neue Einträge für den Zeitraum; Tage ohne Sollzeit überspringen, wenn keine Minuten angegeben sind. */
export function absencesFor(
  targets: readonly { date: string; targetMinutes: number }[],
  kind: AbsenceKind,
  minutes: number | undefined,
): Absence[] {
  return targets
    .filter((d) => minutes !== undefined || d.targetMinutes > 0)
    .map((d) => ({ date: d.date, kind, minutes: minutes ?? d.targetMinutes }));
}

export function AbsencesScreen() {
  const { core, state, days, t } = useMobile();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [kind, setKind] = useState<AbsenceKind>('vacation');
  const [minutes, setMinutes] = useState('');
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const list = [...(state.profile.absences ?? [])].sort((a, b) => b.date.localeCompare(a.date));

  const save = async () => {
    const end = to.trim() || from.trim();
    const start = from.trim();
    const span = (Date.parse(end) - Date.parse(start)) / DAY_MS;
    const mins = minutes.trim() === '' ? undefined : Number(minutes);
    if (
      !DATE.test(start) ||
      !DATE.test(end) ||
      Number.isNaN(span) ||
      span < 0 ||
      span > 365 ||
      (mins !== undefined && (!Number.isInteger(mins) || mins < 0 || mins > 1440))
    ) {
      setMessage({ tone: 'error', text: t.m('absences.invalid') });
      return;
    }
    const period = periodDays(days, state.profile, start, end, end);
    const fresh = absencesFor(period.days, kind, mins);
    const freshDates = new Set(fresh.map((a) => a.date));
    const kept = (state.profile.absences ?? []).filter(
      (a) => a.date >= start && a.date <= end && !freshDates.has(a.date),
    );
    try {
      await core.saveAbsences(start, end, [...kept, ...fresh]);
      setMessage({ tone: 'success', text: t.m('absences.saved') });
      setFrom('');
      setTo('');
      setMinutes('');
    } catch (e) {
      // Firmenkonto: Urlaub/Überstundenabbau nur per Antrag
      const code = e instanceof ApiError ? e.code : '';
      setMessage({
        tone: 'error',
        text: code === 'leave_request_required' ? t.m('absences.useLeave') : t.m('common.error'),
      });
    }
  };

  return (
    <Screen title={t.m('absences.title')}>
      <Section title={t.m('absences.add')}>
        <Field
          label={t.m('absences.from')}
          value={from}
          onChangeText={setFrom}
          autoCapitalize="none"
        />
        <Field label={t.m('absences.to')} value={to} onChangeText={setTo} autoCapitalize="none" />
        <Choice<AbsenceKind>
          label={t.m('absences.kind')}
          value={kind}
          onChange={setKind}
          options={KINDS.map((k) => ({ value: k, label: t.absence(k) }))}
        />
        <Field
          label={t.m('absences.minutes')}
          hint={t.m('absences.weekendSkipped')}
          value={minutes}
          onChangeText={setMinutes}
          inputMode="numeric"
        />
        <Button label={t.m('common.save')} onPress={save} />
        {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      </Section>

      <Section>
        {list.length === 0 ? <Body muted>{t.m('absences.empty')}</Body> : null}
        {list.map((a) => (
          <View key={`${a.date}-${a.kind}`} style={{ gap: 4 }}>
            <Body>{`${formatDate(a.date, t.tag)}: ${t.absence(a.kind)} ${formatMinutes(a.minutes)}`}</Body>
            <Button
              variant="secondary"
              label={t.m('absences.remove', { date: formatDate(a.date, t.tag) })}
              onPress={() => core.saveAbsences(a.date, a.date, [])}
            />
          </View>
        ))}
      </Section>
    </Screen>
  );
}
