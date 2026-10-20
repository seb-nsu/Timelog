// Tagesprotokoll: Sitzungen, erkannte Pausen („War Arbeit“), Ereignisse und Korrektur.
import {
  type LocalEvent,
  detectedBreaks,
  eventsOfDay,
  formatClock,
  formatDate,
  formatMinutes,
} from '@timelog/app-core';
import { addDays, localDate, startOfLocalDay, zonedToUtc } from '@timelog/rules';
import { ApiError } from '@timelog/shared';
import { useEffect, useState } from 'react';
import type { Correction } from '../core/core';
import { Body, Button, Choice, Field, Notice, Row, Screen, Section } from '../ui/components';
import { useMobile } from '../ui/context';
import { DayExtrasSection } from './Extras';

const CLOCK = /^([01]?\d|2[0-3]):[0-5]\d$/;
type FieldKind = Correction['field'];

export function DayLogScreen({ date: initial }: { date?: string }) {
  const { core, state, days, now, t, version } = useMobile();
  const tz = state.timezone;
  const [date, setDate] = useState(initial ?? localDate(Date.parse(now), tz));
  const [events, setEvents] = useState<LocalEvent[]>([]);
  const [message, setMessage] = useState<{
    tone: 'success' | 'error' | 'info';
    text: string;
  } | null>(null);
  const day = days.find((d) => d.date === date);

  useEffect(() => {
    let current = true;
    const from = new Date(startOfLocalDay(addDays(date, -1), tz)).toISOString();
    const to = new Date(startOfLocalDay(addDays(date, 2), tz)).toISOString();
    void core.events(from, to).then((list) => {
      if (current) setEvents(eventsOfDay(list, date));
    });
    return () => {
      current = false;
    };
  }, [core, date, tz, version]);

  const run = async (task: () => Promise<string>) => {
    try {
      setMessage({ tone: 'success', text: await task() });
    } catch (e) {
      const text =
        e instanceof ApiError && e.code === 'reason_required'
          ? t.m('log.reasonRequired')
          : t.m('common.error');
      setMessage({ tone: 'error', text });
    }
  };

  return (
    <Screen title={t.m('log.title')}>
      <Section>
        <Body>{formatDate(date, t.tag)}</Body>
        <Row label={t.m('overview.net')} value={formatMinutes(day?.netMinutes ?? 0)} />
        <Row label={t.t('status.breaks')} value={formatMinutes(day?.breakMinutes ?? 0)} />
        {day ? (
          <>
            <Row label={t.m('overview.target')} value={formatMinutes(day.targetMinutes)} />
            <Body muted>{t.t('log.dayStatus', { status: t.status(day.status) })}</Body>
            {day.corrected ? <Body muted>{t.m('log.manual')}</Body> : null}
          </>
        ) : null}
        <Button
          variant="secondary"
          label={t.t('log.prev')}
          onPress={() => {
            setDate(addDays(date, -1));
            setMessage(null);
          }}
        />
        <Button
          variant="secondary"
          label={t.t('log.next')}
          onPress={() => {
            setDate(addDays(date, 1));
            setMessage(null);
          }}
        />
      </Section>

      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}

      {day?.warnings.map((w) => (
        <Notice key={w} tone="warning">
          {t.warning(w)}
        </Notice>
      ))}

      <Section title={t.m('log.sessions')}>
        {day && day.sessions.length > 0 ? (
          day.sessions.map((s) => (
            <Body key={s.id}>
              {t.m('log.session', {
                from: formatClock(s.start, s.tz),
                to: s.end ? formatClock(s.end, s.tz) : s.open ? t.m('log.open') : t.m('log.noEnd'),
              })}
              {' · '}
              {formatMinutes(s.workMinutes)}
              {s.confirmed === false ? ` · ${t.eventType('session_reject')}` : ''}
            </Body>
          ))
        ) : (
          <Body muted>{t.t('log.empty')}</Body>
        )}
      </Section>

      {detectedBreaks(day).length > 0 ? (
        <Section title={t.t('log.breaks')}>
          {detectedBreaks(day).map((b) => {
            const from = formatClock(b.from, b.tz);
            const to = formatClock(b.to, b.tz);
            return (
              <Button
                key={`${b.from}-${b.to}`}
                variant="secondary"
                label={`${t.t('log.break', { from, to })} – ${t.m('log.wasWork')}`}
                hint={t.m('log.wasWorkHint', { from, to })}
                onPress={() =>
                  run(async () => {
                    await core.manualRange('manual_work', b.from, b.to);
                    return t.m('log.wasWorkDone');
                  })
                }
              />
            );
          })}
        </Section>
      ) : null}

      <DayExtrasSection key={date} date={date} />

      <Section title={t.t('log.events')}>
        {events.length > 0 ? (
          events.map((e) => (
            <Body key={e.id}>
              {t.t('log.event', {
                time: formatClock(e.ts, e.tz),
                type: t.eventType(e.type),
                source: t.source(e.source),
              })}
            </Body>
          ))
        ) : (
          <Body muted>{t.t('log.empty')}</Body>
        )}
      </Section>

      <CorrectionForm
        date={date}
        onSave={(c, reason) =>
          run(async () =>
            (await core.correct(date, c, reason)) === 'server'
              ? t.m('log.correctionServer')
              : t.m('log.correctionQueued'),
          )
        }
        onInvalid={(text) => {
          setMessage({ tone: 'error', text });
        }}
      />

      {state.account === 'loggedIn' && day && day.status !== 'open' ? (
        <Button
          variant="secondary"
          label={t.m('log.confirmDay')}
          onPress={() =>
            run(async () => {
              await core.confirmDay(date);
              return t.m('log.dayConfirmed');
            })
          }
        />
      ) : null}
    </Screen>
  );
}

function CorrectionForm({
  date,
  onSave,
  onInvalid,
}: {
  date: string;
  onSave: (c: Correction, reason: string) => Promise<void>;
  onInvalid: (message: string) => void;
}) {
  const { state, t } = useMobile();
  const tz = state.timezone;
  const [field, setField] = useState<FieldKind>('start');
  const [time, setTime] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [reason, setReason] = useState('');
  const ranged = field === 'break' || field === 'work';
  const toIso = (hhmm: string) =>
    new Date(zonedToUtc(date, hhmm.padStart(5, '0'), tz)).toISOString();

  const save = async () => {
    if (!ranged) {
      if (!CLOCK.test(time)) {
        onInvalid(t.m('log.invalidTime'));
        return;
      }
      await onSave({ field, time: toIso(time) }, reason);
      return;
    }
    if (!CLOCK.test(from) || !CLOCK.test(to)) {
      onInvalid(t.m('log.invalidTime'));
      return;
    }
    const a = toIso(from);
    const b = toIso(to);
    if (Date.parse(b) <= Date.parse(a)) {
      onInvalid(t.m('log.invalidRange'));
      return;
    }
    await onSave({ field, from: a, to: b }, reason);
  };

  return (
    <Section title={t.m('log.correctTitle')}>
      <Choice<FieldKind>
        label={t.m('log.field')}
        value={field}
        onChange={setField}
        options={[
          { value: 'start', label: t.m('log.field.start') },
          { value: 'end', label: t.m('log.field.end') },
          { value: 'break', label: t.m('log.field.break') },
          { value: 'work', label: t.m('log.field.work') },
        ]}
      />
      {ranged ? (
        <>
          <Field label={t.m('log.from')} value={from} onChangeText={setFrom} inputMode="numeric" />
          <Field label={t.m('log.to')} value={to} onChangeText={setTo} inputMode="numeric" />
        </>
      ) : (
        <Field label={t.m('log.time')} value={time} onChangeText={setTime} inputMode="numeric" />
      )}
      <Field
        label={t.m('log.reason')}
        hint={t.m('log.reasonHint')}
        value={reason}
        onChangeText={setReason}
        maxLength={500}
      />
      <Button label={t.m('log.saveCorrection')} onPress={save} />
    </Section>
  );
}
