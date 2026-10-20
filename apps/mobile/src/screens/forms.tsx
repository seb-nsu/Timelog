// Formulare, die Einstellungen und Einrichtungsassistent teilen.
import { STATE_NAMES } from '@timelog/app-core';
import { type GermanState, GERMAN_STATES, localDate, resolveConfig } from '@timelog/rules';
import { ApiError } from '@timelog/shared';
import { useState } from 'react';
import { Button, Choice, Field, Notice } from '../ui/components';
import { useMobile } from '../ui/context';

export function LoginForm({ onDone }: { onDone?: () => void }) {
  const { core, state, t } = useMobile();
  const [baseUrl, setBaseUrl] = useState(state.baseUrl ?? defaultServer());
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const login = async () => {
    setError(null);
    try {
      const res = await core.login({
        baseUrl,
        email: email.trim(),
        password,
        ...(totp.trim() ? { totp: totp.trim() } : {}),
      });
      if (res.totpSetupRequired) setInfo(t.m('setup.totpSetup'));
      onDone?.();
    } catch (e) {
      setError(
        e instanceof ApiError && e.code === 'totp_required'
          ? t.m('setup.totpNeeded')
          : t.m('setup.loginFailed'),
      );
    }
  };

  return (
    <>
      <Field
        label={t.m('setup.server')}
        value={baseUrl}
        onChangeText={setBaseUrl}
        autoCapitalize="none"
        autoCorrect={false}
        inputMode="url"
      />
      <Field
        label={t.m('setup.email')}
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        autoComplete="email"
        inputMode="email"
      />
      <Field
        label={t.m('setup.password')}
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        autoComplete="current-password"
      />
      <Field
        label={t.m('setup.totp')}
        value={totp}
        onChangeText={setTotp}
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={8}
      />
      {error ? <Notice tone="error">{error}</Notice> : null}
      {info ? <Notice tone="info">{info}</Notice> : null}
      <Button testID="login" label={t.m('setup.login')} onPress={login} />
    </>
  );
}

let configuredServer = '';
/** Vorbelegung aus app.config.ts (`extra.defaultServer`), gesetzt beim Start. */
export function setDefaultServer(url: string): void {
  configuredServer = url;
}
function defaultServer(): string {
  return configuredServer;
}

type Week = [number, number, number, number, number, number, number];

export function currentSchedule(schedule: readonly { minutesByWeekday: Week }[] | undefined): Week {
  const fallback = resolveConfig().targetSchedule.at(-1)?.minutesByWeekday;
  return [
    ...(schedule?.at(-1)?.minutesByWeekday ?? fallback ?? [0, 480, 480, 480, 480, 480, 0]),
  ] as Week;
}

/** Bundesland und Sollminuten je Wochentag (Montag zuerst angezeigt). */
export function ProfileForm({ onSaved }: { onSaved?: () => void }) {
  const { core, state, now, t } = useMobile();
  const [region, setRegion] = useState<GermanState>(state.profile.state);
  const [week, setWeek] = useState<string[]>(
    currentSchedule(state.profile.targetSchedule).map(String),
  );
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const order = [1, 2, 3, 4, 5, 6, 0];

  const save = async () => {
    const minutes = week.map((v) => Number(v));
    if (minutes.some((m) => !Number.isInteger(m) || m < 0 || m > 1440)) {
      setMessage({ tone: 'error', text: t.m('common.error') });
      return;
    }
    const validFrom = localDate(Date.parse(now), state.timezone);
    const previous = (state.profile.targetSchedule ?? []).filter((s) => s.validFrom < validFrom);
    try {
      await core.saveProfile({
        ...state.profile,
        state: region,
        targetSchedule: [...previous, { validFrom, minutesByWeekday: minutes as Week }],
      });
      setMessage({ tone: 'success', text: t.m('settings.saved') });
      onSaved?.();
    } catch {
      setMessage({ tone: 'error', text: t.m('common.error') });
    }
  };

  return (
    <>
      <Choice<GermanState>
        label={t.m('settings.state')}
        value={region}
        onChange={setRegion}
        options={GERMAN_STATES.map((s) => ({ value: s, label: STATE_NAMES[s] }))}
      />
      {order.map((d) => (
        <Field
          key={d}
          label={t.m('settings.weekday', { day: t.weekday(d) })}
          value={week[d]}
          inputMode="numeric"
          onChangeText={(v) => {
            setWeek(week.map((x, i) => (i === d ? v : x)));
          }}
        />
      ))}
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      <Button label={t.m('settings.saveProfile')} onPress={save} />
    </>
  );
}
