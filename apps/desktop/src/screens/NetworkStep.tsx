import { useId, useState } from 'react';
import { useBackend, useT } from '../context.js';

/** „Aktuelles Netz übernehmen“: die Kennung geht einmalig an den Server, gespeichert wird dort nur ein HMAC. */
export function AddCurrentNetwork({ onAdded }: { onAdded?: () => void }) {
  const backend = useBackend();
  const { t } = useT();
  const id = useId();
  const [label, setLabel] = useState('Arbeitsplatz');
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);

  const add = async () => {
    setBusy(true);
    try {
      const net = await backend.currentNetwork();
      if (net.fingerprint) {
        await backend.api.networks.add({
          kind: 'fingerprint',
          label,
          fingerprint: net.fingerprint,
        });
      } else if (net.ssid) {
        await backend.api.networks.add({
          kind: 'ssid',
          label,
          ssid: net.ssid,
          ...(net.bssid ? { bssid: net.bssid } : {}),
        });
      } else {
        setMessage(t('setup.networkNone'));
        return;
      }
      setMessage(t('setup.networkSaved', { label }));
      await backend.syncNow();
      onAdded?.();
    } catch {
      setMessage(t('error.generic'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <p>{t('setup.networkHint')}</p>
      <label htmlFor={`${id}-label`}>{t('setup.networkLabel')}</label>
      <input
        id={`${id}-label`}
        required
        maxLength={100}
        value={label}
        onChange={(e) => {
          setLabel(e.target.value);
        }}
      />
      <button type="button" onClick={() => void add()} disabled={busy || label.trim() === ''}>
        {t('action.useCurrentNetwork')}
      </button>
      {message && <p role="status">{message}</p>}
    </div>
  );
}
