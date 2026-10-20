import { type SyntheticEvent, useState } from 'react';
import { errorText } from '../texts.js';
import { ErrorText, Loading, useAdmin, useLoad } from '../ui.js';

const KIND_LABELS = {
  fingerprint: 'Netzwerk-Kennung',
  ssid: 'WLAN-Name',
  geofence: 'Geofence',
} as const;

/** Firmen-Arbeitsnetze: gelten automatisch für alle Mitglieder. */
export function Networks() {
  const { api, notify } = useAdmin();
  const list = useLoad(() => api.org.networks.list(), [api]);
  const [label, setLabel] = useState('');
  const [kind, setKind] = useState<'fingerprint' | 'ssid'>('fingerprint');
  const [value, setValue] = useState('');
  const [error, setError] = useState<string>();

  const add = async (e: SyntheticEvent) => {
    e.preventDefault();
    setError(undefined);
    try {
      await api.org.networks.add(
        kind === 'fingerprint'
          ? { kind, label: label.trim(), fingerprint: value.trim() }
          : { kind, label: label.trim(), ssid: value.trim() },
      );
      notify(`Netz ${label.trim()} hinzugefügt.`);
      setLabel('');
      setValue('');
      list.reload();
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <section aria-labelledby="page-title" className="stack">
      <h1 id="page-title" tabIndex={-1}>
        Firmen-Arbeitsnetze
      </h1>
      <p className="muted">
        Firmen-Netze gelten automatisch für alle Mitglieder. Standard ist die Netzwerk-Kennung
        (funktioniert auch per LAN und an der Dockingstation, ohne Standortfreigabe). Gespeichert
        wird nur ein HMAC mit dem Schlüssel der Organisation. Hinweis: Eine Netzwerk-Kennung lässt
        sich mit eigenem Router nachbauen.
      </p>
      <ErrorText text={list.error} />
      {!list.data && !list.error && <Loading what="Netze" />}
      {list.data && list.data.networks.length === 0 && <p>Noch keine Firmen-Netze hinterlegt.</p>}
      {list.data && list.data.networks.length > 0 && (
        <ul className="plain">
          {list.data.networks.map((n) => (
            <li key={n.id} className="row card">
              <span>
                <strong>{n.label}</strong> · {KIND_LABELS[n.kind]}
                {n.ssid ? ` „${n.ssid}“` : ''}
              </span>
              <button
                type="button"
                className="danger"
                onClick={() => {
                  void api.org.networks.remove(n.id).then(
                    () => {
                      notify(`Netz ${n.label} entfernt.`);
                      list.reload();
                    },
                    (err: unknown) => {
                      setError(errorText(err));
                    },
                  );
                }}
              >
                Entfernen<span className="visually-hidden">: {n.label}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <form className="card" onSubmit={(e) => void add(e)}>
        <h2>Netz hinzufügen</h2>
        <label>
          Bezeichnung
          <input
            required
            value={label}
            onChange={(e) => {
              setLabel(e.target.value);
            }}
          />
        </label>
        <fieldset>
          <legend>Art</legend>
          <label className="inline">
            <input
              type="radio"
              name="kind"
              checked={kind === 'fingerprint'}
              onChange={() => {
                setKind('fingerprint');
              }}
            />
            Netzwerk-Kennung (Standard)
          </label>
          <label className="inline">
            <input
              type="radio"
              name="kind"
              checked={kind === 'ssid'}
              onChange={() => {
                setKind('ssid');
              }}
            />
            WLAN-Name
          </label>
        </fieldset>
        <label>
          {kind === 'fingerprint'
            ? 'Netzwerk-Kennung (aus der Desktop-App: „Aktuelles Netz übernehmen“)'
            : 'WLAN-Name (SSID)'}
          <input
            required
            minLength={kind === 'fingerprint' ? 8 : 1}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
            }}
          />
        </label>
        <ErrorText text={error} />
        <button type="submit" className="primary">
          Hinzufügen
        </button>
      </form>
    </section>
  );
}
