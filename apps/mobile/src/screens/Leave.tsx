// Urlaubs- und Überstundenkonto der Firmenversion: Stand, Antrag, Stornierung, Saldo-Verlauf.
// Teil des Bereichs „Abwesenheit“. Gerechnet wird im Backend (@timelog/rules); die App zeigt nur an.
import { type MessageKey, formatBalance, formatDate, formatMinutes } from '@timelog/app-core';
import { localDate } from '@timelog/rules';
import {
  ApiError,
  type LeaveKindValue,
  type LeaveOverview,
  type LeaveRequest,
  type OvertimeView,
} from '@timelog/shared';
import { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import { Body, Button, Choice, Field, Notice, Row, Section, ToggleRow } from '../ui/components';
import { useMobile } from '../ui/context';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ERRORS = ['overlapping_request', 'month_locked', 'no_workdays', 'already_started'] as const;

export interface LeaveData {
  overview: LeaveOverview | undefined;
  overtime: OvertimeView | undefined;
  load: () => Promise<void>;
}

/** Urlaubs- und Überstundenkonto laden; `overview.managed` = Firmenkonto. */
export function useLeave(): LeaveData {
  const { core, state, now, version } = useMobile();
  const year = Number(localDate(Date.parse(now), state.timezone).slice(0, 4));
  const [overview, setOverview] = useState<LeaveOverview>();
  const [overtime, setOvertime] = useState<OvertimeView>();
  const loggedIn = state.account === 'loggedIn';

  const load = useCallback(async () => {
    if (!loggedIn) return;
    try {
      const api = await core.api();
      setOverview(await api.leave.get(year));
      setOvertime(await api.overtime.get(year));
    } catch {
      setOverview(undefined);
      setOvertime(undefined);
    }
  }, [core, loggedIn, year]);

  useEffect(() => {
    void load();
  }, [load, version]);

  return { overview, overtime, load };
}

/** Nur für Firmenkonten: Konto, Antrag (Urlaub, Überstundenabbau), Anträge, Überstunden. */
export function LeaveSections({ leave }: { leave: LeaveData }) {
  const { core, state, now, t } = useMobile();
  const today = localDate(Date.parse(now), state.timezone);
  const { overview, overtime, load } = leave;
  const [kind, setKind] = useState<LeaveKindValue>('vacation');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [halfStart, setHalfStart] = useState(false);
  const [halfEnd, setHalfEnd] = useState(false);
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const num = (n: number) => n.toLocaleString(t.tag, { maximumFractionDigits: 1 });
  const daysText = (n: number) => t.t('leave.days', { days: num(n) });

  const fail = (e: unknown) => {
    const code = e instanceof ApiError ? e.code : '';
    setMessage({
      tone: 'error',
      text: (ERRORS as readonly string[]).includes(code)
        ? t.t(`leave.error.${code}` as MessageKey)
        : t.m('common.error'),
    });
  };

  const submit = async () => {
    const start = from.trim();
    const end = to.trim() || start;
    if (!DATE.test(start) || !DATE.test(end) || end < start) {
      setMessage({ tone: 'error', text: t.m('absences.invalid') });
      return;
    }
    try {
      const api = await core.api();
      const r = await api.leave.request({
        kind,
        from: start,
        to: end,
        halfDayStart: halfStart,
        halfDayEnd: halfEnd,
      });
      setMessage({
        tone: 'success',
        text: r.status === 'pending' ? t.t('leave.submitted') : t.t('leave.approvedNow'),
      });
      setFrom('');
      setTo('');
      setHalfStart(false);
      setHalfEnd(false);
      await load();
    } catch (e) {
      fail(e);
    }
  };

  const cancel = async (r: LeaveRequest) => {
    try {
      await (await core.api()).leave.cancel(r.id);
      setMessage({ tone: 'success', text: t.t('leave.cancelled') });
      await load();
    } catch (e) {
      fail(e);
    }
  };

  const a = overview?.account;
  return (
    <>
      {a ? (
        <Section title={t.t('leave.account', { year: a.year })}>
          <Row label={t.t('leave.entitlement')} value={daysText(a.entitlement)} />
          {a.carryOver !== 0 ? (
            <Row
              label={t.t('leave.carryOver')}
              value={`${daysText(a.carryOver)} (${t.t('leave.carryOverExpiry', {
                date: formatDate(a.carryOverExpiry, t.tag),
              })})`}
            />
          ) : null}
          {a.carryOverForfeited > 0 ? (
            <Row label={t.t('leave.carryOverForfeited')} value={daysText(a.carryOverForfeited)} />
          ) : null}
          {a.correction !== 0 ? (
            <Row label={t.t('leave.correction')} value={daysText(a.correction)} />
          ) : null}
          <Row label={t.t('leave.taken')} value={daysText(a.taken)} />
          <Row label={t.t('leave.planned')} value={daysText(a.planned)} />
          <Row label={t.t('leave.pending')} value={daysText(a.pending)} />
          <Row label={t.t('leave.remaining')} value={daysText(a.remaining)} />
          {overview.managed ? <Body muted>{t.t('leave.managed')}</Body> : null}
          {overview.settings.carryOverExpires ? <Body muted>{t.t('leave.bagHint')}</Body> : null}
        </Section>
      ) : null}

      <Section title={t.t('leave.request')}>
        <Choice<LeaveKindValue>
          label={t.t('leave.kind')}
          value={kind}
          onChange={setKind}
          options={[
            { value: 'vacation', label: t.t('leave.kind.vacation') },
            { value: 'overtime', label: t.t('leave.kind.overtime') },
          ]}
        />
        <Field
          label={t.t('leave.from')}
          hint={t.m('leave.dateHint')}
          value={from}
          onChangeText={setFrom}
          autoCapitalize="none"
        />
        <Field
          label={t.t('leave.to')}
          hint={t.m('leave.dateHint')}
          value={to}
          onChangeText={setTo}
          autoCapitalize="none"
        />
        <ToggleRow
          label={t.t('leave.halfDayStart')}
          value={halfStart}
          onValueChange={setHalfStart}
        />
        <ToggleRow label={t.t('leave.halfDayEnd')} value={halfEnd} onValueChange={setHalfEnd} />
        <Button label={t.t('leave.submit')} onPress={submit} />
        {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      </Section>

      <Section title={t.t('leave.requests')}>
        {!overview || overview.requests.length === 0 ? (
          <Body muted>{t.t('leave.noRequests')}</Body>
        ) : null}
        {overview?.requests.map((r) => {
          const label = `${t.t(`leave.kind.${r.kind}`)} ${t.t('leave.range', {
            from: formatDate(r.from, t.tag),
            to: formatDate(r.to, t.tag),
          })}`;
          return (
            <View key={r.id} style={{ gap: 4 }}>
              <Body>{`${label} · ${daysText(r.days)} · ${t.t(`leave.status.${r.status}`)}`}</Body>
              {r.decisionComment ? (
                <Body muted>{t.t('leave.decision', { comment: r.decisionComment })}</Body>
              ) : null}
              {(r.status === 'pending' || r.status === 'approved') && r.from > today ? (
                <Button
                  variant="secondary"
                  label={`${t.t('leave.cancel')}: ${label}`}
                  onPress={() => cancel(r)}
                />
              ) : null}
            </View>
          );
        })}
      </Section>

      {overtime ? (
        <Section title={t.t('overtime.title', { year: overtime.year })}>
          <Row
            label={t.t('overtime.balance')}
            value={`${formatBalance(overtime.balanceMinutes)} h`}
          />
          {overtime.overMax && overtime.maxBalanceMinutes !== undefined ? (
            <Notice tone="warning">
              {t.t('overtime.overMax', { max: formatBalance(overtime.maxBalanceMinutes) })}
            </Notice>
          ) : null}
          <Row
            label={t.t('overtime.start')}
            value={`${formatBalance(overtime.startBalanceMinutes)} h`}
          />
          {overtime.months.map((m) => (
            <Row
              key={m.month}
              label={`${m.month}${m.approved ? ` (${t.t('overtime.approved')})` : ''}`}
              value={`${formatBalance(m.balanceMinutes)} h${
                m.reducedMinutes > 0
                  ? ` · ${t.t('overtime.reduced')} ${formatMinutes(m.reducedMinutes)}`
                  : ''
              }`}
            />
          ))}
        </Section>
      ) : null}
    </>
  );
}
