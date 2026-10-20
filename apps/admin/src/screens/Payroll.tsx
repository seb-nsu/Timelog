// Lohn (nur Admin): Lohnarten, Personalnummern, Export für DATEV/Lexware aus freigegebenen
// Monaten, Personio-Zugang und Übertragung mit Ergebnisprotokoll.
import type { PayrollConfig } from '@timelog/shared';
import { type SyntheticEvent, useState } from 'react';
import {
  PAYROLL_FORMAT_LABELS,
  TRANSFER_LABELS,
  dateTime,
  errorText,
  previousMonth,
} from '../texts.js';
import { ErrorText, Loading, useAdmin, useLoad } from '../ui.js';

type Format = keyof typeof PAYROLL_FORMAT_LABELS;
const KINDS = [
  ['hours', 'Arbeitsstunden'],
  ['vacation', 'Urlaub'],
  ['sick', 'Krankheit'],
  ['overtime', 'Überstundenabbau'],
] as const;

export function Payroll({ download }: { download: (blob: Blob, filename: string) => void }) {
  return (
    <section aria-labelledby="page-title" className="stack">
      <h1 id="page-title" tabIndex={-1}>
        Lohn
      </h1>
      <p className="muted">
        Exportiert werden nur freigegebene Monate – die Werte stammen aus dem Snapshot der Freigabe
        und werden nie neu berechnet. Mitglieder ohne Freigabe oder ohne Personalnummer werden
        übersprungen.
      </p>
      <PayrollExport download={download} />
      <PersonnelNumbers />
      <ConfigForm />
      <Personio />
    </section>
  );
}

function PayrollExport({ download }: { download: (blob: Blob, filename: string) => void }) {
  const { api, now, notify } = useAdmin();
  const [month, setMonth] = useState(() => previousMonth(now()));
  const [format, setFormat] = useState<Format>('datev_lodas');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const run = async (e: SyntheticEvent) => {
    e.preventDefault();
    setError(undefined);
    setBusy(true);
    try {
      const blob = await api.org.payroll.export({ month, format });
      download(blob, `lohn_${format}_${month}.${format === 'datev_lodas' ? 'txt' : 'csv'}`);
      notify(`Lohn-Export ${month} (${PAYROLL_FORMAT_LABELS[format]}) erstellt.`);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card" aria-labelledby="payroll-export">
      <h2 id="payroll-export">Export für das Lohnprogramm</h2>
      <form className="stack" onSubmit={(e) => void run(e)}>
        <label>
          Monat
          <input
            type="month"
            required
            value={month}
            onChange={(e) => {
              setMonth(e.target.value);
            }}
          />
        </label>
        <fieldset>
          <legend>Format</legend>
          {(Object.keys(PAYROLL_FORMAT_LABELS) as Format[]).map((f) => (
            <label key={f} className="inline">
              <input
                type="radio"
                name="payroll-format"
                checked={format === f}
                onChange={() => {
                  setFormat(f);
                }}
              />
              {PAYROLL_FORMAT_LABELS[f]}
            </label>
          ))}
        </fieldset>
        <ErrorText text={error} />
        <button type="submit" className="primary" disabled={busy}>
          Lohndatei herunterladen
        </button>
      </form>
    </section>
  );
}

function PersonnelNumbers() {
  const { api, notify } = useAdmin();
  const list = useLoad(() => api.org.payroll.members(), [api]);
  const [edits, setEdits] = useState<Record<string, { pn: string; pid: string }>>({});
  const [error, setError] = useState<string>();

  const save = async (userId: string) => {
    const e = edits[userId];
    if (!e) return;
    setError(undefined);
    try {
      await api.org.payroll.setMember(userId, {
        personnelNumber: e.pn.trim() || null,
        personioId: e.pid.trim() || null,
      });
      notify('Zuordnung gespeichert.');
      list.reload();
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <section className="card" aria-labelledby="payroll-members">
      <h2 id="payroll-members">Personalnummern</h2>
      <ErrorText text={list.error ?? error} />
      {!list.data && !list.error && <Loading what="Mitglieder" />}
      {list.data && (
        <table>
          <caption className="visually-hidden">Personalnummer und Personio-ID je Mitglied</caption>
          <thead>
            <tr>
              <th scope="col">Person</th>
              <th scope="col">Personalnummer</th>
              <th scope="col">Personio-ID (optional)</th>
              <th scope="col">
                <span className="visually-hidden">Aktion</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {list.data.members.map((m) => {
              const e = edits[m.userId] ?? {
                pn: m.personnelNumber ?? '',
                pid: m.personioId ?? '',
              };
              const set = (patch: Partial<typeof e>) => {
                setEdits((all) => ({ ...all, [m.userId]: { ...e, ...patch } }));
              };
              return (
                <tr key={m.userId}>
                  <th scope="row">{m.name}</th>
                  <td>
                    <input
                      type="text"
                      aria-label={`Personalnummer ${m.name}`}
                      maxLength={19}
                      value={e.pn}
                      onChange={(ev) => {
                        set({ pn: ev.target.value });
                      }}
                    />
                  </td>
                  <td>
                    <input
                      type="text"
                      aria-label={`Personio-ID ${m.name}`}
                      maxLength={64}
                      value={e.pid}
                      onChange={(ev) => {
                        set({ pid: ev.target.value });
                      }}
                    />
                  </td>
                  <td>
                    <button
                      type="button"
                      disabled={!edits[m.userId]}
                      onClick={() => void save(m.userId)}
                    >
                      Speichern<span className="visually-hidden">: {m.name}</span>
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

function ConfigForm() {
  const { api } = useAdmin();
  const cfg = useLoad(() => api.org.payroll.config(), [api]);
  if (!cfg.data) return <ErrorText text={cfg.error} />;
  return <ConfigFields key={JSON.stringify(cfg.data)} initial={cfg.data} onSaved={cfg.reload} />;
}

function ConfigFields({ initial, onSaved }: { initial: PayrollConfig; onSaved: () => void }) {
  const { api, notify } = useAdmin();
  const [cfg, setCfg] = useState<PayrollConfig>(initial);
  const [error, setError] = useState<string>();
  const opt = (v: string) => (v.trim() === '' ? undefined : v.trim());

  const submit = async (e: SyntheticEvent) => {
    e.preventDefault();
    setError(undefined);
    try {
      await api.org.payroll.setConfig(cfg);
      notify('Lohn-Einstellungen gespeichert.');
      onSaved();
    } catch (err) {
      setError(errorText(err));
    }
  };

  const field = (
    label: string,
    value: string | undefined,
    onChange: (v: string | undefined) => void,
    pattern: string,
  ) => (
    <label>
      {label}
      <input
        type="text"
        inputMode="numeric"
        pattern={pattern}
        value={value ?? ''}
        onChange={(e) => {
          onChange(opt(e.target.value));
        }}
      />
    </label>
  );

  return (
    <section className="card" aria-labelledby="payroll-config">
      <h2 id="payroll-config">Lohnarten und Schlüssel</h2>
      <p className="muted">
        Die Nummern legt das Lohnbüro bzw. die Steuerberatung fest. Arten ohne Lohnart werden nicht
        exportiert. Feiertage rechnet das Lohnprogramm selbst.
      </p>
      <form className="stack" onSubmit={(e) => void submit(e)}>
        <fieldset>
          <legend>DATEV</legend>
          {field(
            'Beraternummer',
            cfg.datev.beraterNr,
            (v) => {
              setCfg({ ...cfg, datev: { ...cfg.datev, beraterNr: v } });
            },
            '[0-9]{4,7}',
          )}
          {field(
            'Mandantennummer',
            cfg.datev.mandantenNr,
            (v) => {
              setCfg({ ...cfg, datev: { ...cfg.datev, mandantenNr: v } });
            },
            '[0-9]{1,5}',
          )}
          {KINDS.map(([k, label]) => (
            <div key={k}>
              {field(
                `Lohnart ${label}`,
                cfg.datev.wageTypes[k],
                (v) => {
                  setCfg({
                    ...cfg,
                    datev: { ...cfg.datev, wageTypes: { ...cfg.datev.wageTypes, [k]: v } },
                  });
                },
                '[0-9]{1,4}',
              )}
            </div>
          ))}
          {KINDS.filter(([k]) => k !== 'hours').map(([k, label]) => (
            <label key={k}>
              LODAS-Ausfallschlüssel {label}
              <input
                type="text"
                pattern="[A-Za-z0-9]{1,3}"
                value={cfg.datev.absenceCodes[k as 'vacation' | 'sick' | 'overtime'] ?? ''}
                onChange={(e) => {
                  setCfg({
                    ...cfg,
                    datev: {
                      ...cfg.datev,
                      absenceCodes: { ...cfg.datev.absenceCodes, [k]: opt(e.target.value) },
                    },
                  });
                }}
              />
            </label>
          ))}
        </fieldset>
        <fieldset>
          <legend>Lexware lohn+gehalt</legend>
          {KINDS.map(([k, label]) => (
            <div key={k}>
              {field(
                `Lohnartnummer ${label}`,
                cfg.lexware.wageTypes[k],
                (v) => {
                  setCfg({
                    ...cfg,
                    lexware: { wageTypes: { ...cfg.lexware.wageTypes, [k]: v } },
                  });
                },
                '[0-9]{1,4}',
              )}
            </div>
          ))}
        </fieldset>
        <fieldset>
          <legend>Personio</legend>
          <label>
            Zuordnung der Personen
            <select
              value={cfg.personio.matchBy}
              onChange={(e) => {
                setCfg({
                  ...cfg,
                  personio: {
                    ...cfg.personio,
                    matchBy: e.target.value === 'personio_id' ? 'personio_id' : 'email',
                  },
                });
              }}
            >
              <option value="email">über die E-Mail-Adresse (sonst hinterlegte ID)</option>
              <option value="personio_id">nur über die hinterlegte Personio-ID</option>
            </select>
          </label>
          <label className="inline">
            <input
              type="checkbox"
              checked={cfg.personio.skipApproval}
              onChange={(e) => {
                setCfg({ ...cfg, personio: { ...cfg.personio, skipApproval: e.target.checked } });
              }}
            />
            Genehmigung in Personio überspringen (Monat ist in TimeLog freigegeben)
          </label>
        </fieldset>
        <ErrorText text={error} />
        <button type="submit" className="primary">
          Lohn-Einstellungen speichern
        </button>
      </form>
    </section>
  );
}

function Personio() {
  const { api, now, notify } = useAdmin();
  const status = useLoad(() => api.org.payroll.personio.status(), [api]);
  const log = useLoad(() => api.org.payroll.personio.transfers(), [api]);
  const [clientId, setClientId] = useState('');
  const [secret, setSecret] = useState('');
  const [month, setMonth] = useState(() => previousMonth(now()));
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const saveCreds = async (e: SyntheticEvent) => {
    e.preventDefault();
    setError(undefined);
    try {
      await api.org.payroll.personio.set({ clientId, clientSecret: secret });
      setSecret('');
      notify('Personio-Zugang gespeichert (verschlüsselt).');
      status.reload();
    } catch (err) {
      setError(errorText(err));
    }
  };

  const transfer = async () => {
    setError(undefined);
    setBusy(true);
    try {
      const r = await api.org.payroll.personio.transfer(month);
      notify(`Übertragung ${month}: ${TRANSFER_LABELS[r.status]}.`);
      log.reload();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card" aria-labelledby="personio-title">
      <h2 id="personio-title">Personio</h2>
      <p className="muted">
        Überträgt die tatsächlichen Arbeitsabschnitte eines freigegebenen Monats als Anwesenheiten
        (API v2). Eine erneute Übertragung ersetzt die zuvor übertragenen Einträge.
      </p>
      {status.data?.configured ? (
        <p>
          Zugang hinterlegt (Client-ID {status.data.clientId}
          {status.data.updatedAt && `, geändert ${dateTime(status.data.updatedAt)}`}).{' '}
          <button
            type="button"
            onClick={() =>
              void api.org.payroll.personio.remove().then(() => {
                notify('Personio-Zugang entfernt.');
                status.reload();
              })
            }
          >
            Zugang entfernen
          </button>
        </p>
      ) : (
        <p>Noch kein Zugang hinterlegt.</p>
      )}
      <form className="stack" onSubmit={(e) => void saveCreds(e)}>
        <label>
          Client-ID
          <input
            type="text"
            required
            autoComplete="off"
            value={clientId}
            onChange={(e) => {
              setClientId(e.target.value);
            }}
          />
        </label>
        <label>
          Client-Secret
          <input
            type="password"
            required
            autoComplete="off"
            value={secret}
            onChange={(e) => {
              setSecret(e.target.value);
            }}
          />
        </label>
        <button type="submit">Zugang speichern</button>
      </form>
      <div className="row">
        <label className="inline">
          Monat
          <input
            type="month"
            value={month}
            onChange={(e) => {
              if (e.target.value) setMonth(e.target.value);
            }}
          />
        </label>
        <button
          type="button"
          className="primary"
          disabled={busy || status.data?.configured !== true}
          onClick={() => void transfer()}
        >
          Übertragen
        </button>
      </div>
      <ErrorText text={error} />
      <h3>Ergebnisprotokoll</h3>
      {log.data && log.data.transfers.length === 0 && <p>Noch keine Übertragung.</p>}
      {log.data && log.data.transfers.length > 0 && (
        <ul>
          {log.data.transfers.map((t) => (
            <li key={t.id}>
              {dateTime(t.createdAt)} · {t.month} · {TRANSFER_LABELS[t.status]}
              {t.actorName && ` · ${t.actorName}`}
              <ul>
                {t.members.map((m) => (
                  <li key={m.userId}>
                    {m.name}: {TRANSFER_LABELS[m.status]}
                    {m.periods > 0 && ` (${String(m.periods)} Einträge)`}
                    {m.message && ` – ${m.message}`}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
