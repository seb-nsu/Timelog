// Abwesenheit: ein Bereich für Urlaub, Krankheit und Sonstiges. Firmenkonten stellen Urlaub und
// Überstundenabbau als Antrag und sehen ihr Urlaubs- und Überstundenkonto; Privatkonten tragen direkt ein.
// Ohne Minutenangabe zählt die Sollzeit des Tages; Feiertage kommen automatisch aus dem Bundesland.
import { absencesFor, formatDate, formatMinutes, periodDays } from '@timelog/app-core';
import type { AbsenceKind } from '@timelog/rules';
import { ApiError } from '@timelog/shared';
import { useState } from 'react';
import { View } from 'react-native';
import { Body, Button, Choice, Field, Notice, Screen, Section } from '../ui/components';
import { useMobile } from '../ui/context';
import { LeaveSections, useLeave } from './Leave';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
/** Bei Firmenkonten nur per Antrag (oben im Bereich). */
const REQUEST_KINDS: readonly AbsenceKind[] = ['vacation', 'overtime'];

export function AbsenceScreen() {
  const { core, state, days, t } = useMobile();
  const leave = useLeave();
  const managed = leave.overview?.managed === true;
  const kinds: AbsenceKind[] = managed ? ['sick', 'other'] : ['vacation', 'sick', 'other'];
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [chosen, setKind] = useState<AbsenceKind>('sick');
  const kind = kinds.includes(chosen) ? chosen : 'sick';
  const [minutes, setMinutes] = useState('');
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  // Firmenkonten sehen Urlaub und Überstundenabbau unter „Anträge“
  const list = [...(state.profile.absences ?? [])]
    .filter((a) => a.kind !== 'holiday' && !(managed && REQUEST_KINDS.includes(a.kind)))
    .sort((a, b) => b.date.localeCompare(a.date));

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
      {managed ? <LeaveSections leave={leave} /> : null}
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
          options={kinds.map((k) => ({ value: k, label: t.absence(k) }))}
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
