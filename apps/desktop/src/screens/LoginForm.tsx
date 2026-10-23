import { ApiError } from '@timelog/shared';
import { type SyntheticEvent, useId, useState } from 'react';
import { useBackend, useT } from '../context.js';

const ERROR_KEYS = {
  invalid_credentials: 'error.login',
  totp_required: 'error.totp',
  invalid_totp: 'error.totp',
} as const;

export function LoginForm({ defaultUrl, onDone }: { defaultUrl: string; onDone: () => void }) {
  const backend = useBackend();
  const { t } = useT();
  const id = useId();
  const [baseUrl, setBaseUrl] = useState(defaultUrl);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);

  const submit = async (e: SyntheticEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const result = await backend.login({ baseUrl, email, password, ...(totp ? { totp } : {}) });
      if (result.totpSetupRequired) setNotice(t('setup.totpRequired'));
      onDone();
    } catch (err) {
      const code = typeof err === 'string' ? err : err instanceof ApiError ? err.code : '';
      setError(
        t(code in ERROR_KEYS ? ERROR_KEYS[code as keyof typeof ERROR_KEYS] : 'error.generic'),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} aria-describedby={error ? `${id}-error` : undefined}>
      <label htmlFor={`${id}-url`}>{t('setup.server')}</label>
      <input
        id={`${id}-url`}
        type="url"
        required
        autoComplete="url"
        placeholder="https://"
        value={baseUrl}
        onChange={(e) => {
          setBaseUrl(e.target.value);
        }}
      />
      <label htmlFor={`${id}-email`}>{t('setup.email')}</label>
      <input
        id={`${id}-email`}
        type="email"
        required
        autoComplete="username"
        value={email}
        onChange={(e) => {
          setEmail(e.target.value);
        }}
      />
      <label htmlFor={`${id}-password`}>{t('setup.password')}</label>
      <input
        id={`${id}-password`}
        type="password"
        required
        autoComplete="current-password"
        value={password}
        onChange={(e) => {
          setPassword(e.target.value);
        }}
      />
      <label htmlFor={`${id}-totp`}>{t('setup.totp')}</label>
      <input
        id={`${id}-totp`}
        inputMode="numeric"
        pattern="\d{6}"
        autoComplete="one-time-code"
        value={totp}
        onChange={(e) => {
          setTotp(e.target.value);
        }}
      />
      {error && (
        <p id={`${id}-error`} role="alert" className="error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <button type="submit" className="primary" disabled={busy}>
        {t('action.login')}
      </button>
    </form>
  );
}
