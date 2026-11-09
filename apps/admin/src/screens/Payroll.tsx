// Lohn (nur Admin): Lohnarten, Personalnummern, Export für DATEV/Lexware aus freigegebenen
// Monaten, Personio-Zugang und Übertragung mit Ergebnisprotokoll.
import type { PayrollConfig } from '@timelog/shared';
import { type SyntheticEvent, useState } from 'react';
import {
  L,
  PAYROLL_FORMAT_LABELS,
  TRANSFER_LABELS,
  dateTime,
  errorText,
  previousMonth,
  transferMessage,
} from '../texts.js';
import { ErrorText, Loading, useAdmin, useLoad } from '../ui.js';

type Format = keyof typeof PAYROLL_FORMAT_LABELS;
const KINDS = [
  ['hours', L('Arbeitsstunden', 'working hours')],
  ['vacation', L('Urlaub', 'vacation')],
  ['sick', L('Krankheit', 'sickness')],
  ['overtime', L('Überstundenabbau', 'overtime reduction')],
] as const;

export function Payroll({ download }: { download: (blob: Blob, filename: string) => void }) {
  return (
    <section aria-labelledby="page-title" className="stack">
      <h1 id="page-title" tabIndex={-1}>
        {L('Lohn', 'Payroll')}
      </h1>
      <p className="muted">
        {L(
          'Exportiert werden nur freigegebene Monate – die Werte stammen aus dem Snapshot der Freigabe und werden nie neu berechnet. Mitglieder ohne Freigabe oder ohne Personalnummer werden übersprungen.',
          'Only approved months are exported. The values come from the approval snapshot and are never recalculated. Members without approval or without a personnel number are skipped.',
        )}
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
      notify(
        L(
          `Lohn-Export ${month} (${PAYROLL_FORMAT_LABELS[format]}) erstellt.`,
          `Payroll export ${month} (${PAYROLL_FORMAT_LABELS[format]}) created.`,
        ),
      );
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card" aria-labelledby="payroll-export">
      <h2 id="payroll-export">{L('Export für das Lohnprogramm', 'Export for payroll software')}</h2>
      <form className="stack" onSubmit={(e) => void run(e)}>
        <label>
          {L('Monat', 'Month')}
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
          {L('Lohndatei herunterladen', 'Download payroll file')}
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
      notify(L('Zuordnung gespeichert.', 'Mapping saved.'));
      list.reload();
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <section className="card" aria-labelledby="payroll-members">
      <h2 id="payroll-members">{L('Personalnummern', 'Personnel numbers')}</h2>
      <ErrorText text={list.error ?? error} />
      {!list.data && !list.error && <Loading what={L('Mitglieder', 'members')} />}
      {list.data && (
        <table>
          <caption className="visually-hidden">
            {L(
              'Personalnummer und Personio-ID je Mitglied',
              'Personnel number and Personio ID per member',
            )}
          </caption>
          <thead>
            <tr>
              <th scope="col">Person</th>
              <th scope="col">{L('Personalnummer', 'Personnel number')}</th>
              <th scope="col">{L('Personio-ID (optional)', 'Personio ID (optional)')}</th>
              <th scope="col">
                <span className="visually-hidden">{L('Aktion', 'Action')}</span>
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
                      aria-label={L(`Personalnummer ${m.name}`, `Personnel number ${m.name}`)}
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
                      aria-label={L(`Personio-ID ${m.name}`, `Personio ID ${m.name}`)}
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
                      {L('Speichern', 'Save')}
                      <span className="visually-hidden">: {m.name}</span>
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
      notify(L('Lohn-Einstellungen gespeichert.', 'Payroll settings saved.'));
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
      <h2 id="payroll-config">{L('Lohnarten und Schlüssel', 'Wage types and codes')}</h2>
      <p className="muted">
        {L(
          'Die Nummern legt das Lohnbüro bzw. die Steuerberatung fest. Arten ohne Lohnart werden nicht exportiert. Feiertage rechnet das Lohnprogramm selbst.',
          'The numbers are set by your payroll office or tax adviser. Types without a wage type are not exported. The payroll software handles public holidays itself.',
        )}
      </p>
      <form className="stack" onSubmit={(e) => void submit(e)}>
        <fieldset>
          <legend>DATEV</legend>
          {field(
            L('Beraternummer', 'Consultant number'),
            cfg.datev.beraterNr,
            (v) => {
              setCfg({ ...cfg, datev: { ...cfg.datev, beraterNr: v } });
            },
            '[0-9]{4,7}',
          )}
          {field(
            L('Mandantennummer', 'Client number'),
            cfg.datev.mandantenNr,
            (v) => {
              setCfg({ ...cfg, datev: { ...cfg.datev, mandantenNr: v } });
            },
            '[0-9]{1,5}',
          )}
          {KINDS.map(([k, label]) => (
            <div key={k}>
              {field(
                `${L('Lohnart', 'Wage type')} ${label}`,
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
              {L('LODAS-Ausfallschlüssel', 'LODAS absence code')} {label}
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
                `${L('Lohnartnummer', 'Wage type number')} ${label}`,
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
            {L('Zuordnung der Personen', 'Matching people')}
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
              <option value="email">
                {L(
                  'über die E-Mail-Adresse (sonst hinterlegte ID)',
                  'by email address (otherwise stored ID)',
                )}
              </option>
              <option value="personio_id">
                {L('nur über die hinterlegte Personio-ID', 'only by the stored Personio ID')}
              </option>
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
            {L(
              'Genehmigung in Personio überspringen (Monat ist in TimeLog freigegeben)',
              'Skip approval in Personio (month is approved in TimeLog)',
            )}
          </label>
        </fieldset>
        <ErrorText text={error} />
        <button type="submit" className="primary">
          {L('Lohn-Einstellungen speichern', 'Save payroll settings')}
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
      notify(
        L(
          'Personio-Zugang gespeichert (verschlüsselt).',
          'Personio credentials saved (encrypted).',
        ),
      );
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
      notify(L(`Übertragung ${month}: `, `Transfer ${month}: `) + `${TRANSFER_LABELS[r.status]}.`);
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
        {L(
          'Überträgt die tatsächlichen Arbeitsabschnitte eines freigegebenen Monats als Anwesenheiten (API v2). Eine erneute Übertragung ersetzt die zuvor übertragenen Einträge.',
          'Transfers the actual work periods of an approved month as attendances (API v2). A new transfer replaces the previously transferred entries.',
        )}
      </p>
      {status.data?.configured ? (
        <p>
          {L('Zugang hinterlegt (Client-ID', 'Credentials stored (client ID')}{' '}
          {status.data.clientId}
          {status.data.updatedAt &&
            L(
              `, geändert ${dateTime(status.data.updatedAt)}`,
              `, changed ${dateTime(status.data.updatedAt)}`,
            )}
          ).{' '}
          <button
            type="button"
            onClick={() =>
              void api.org.payroll.personio.remove().then(() => {
                notify(L('Personio-Zugang entfernt.', 'Personio credentials removed.'));
                status.reload();
              })
            }
          >
            {L('Zugang entfernen', 'Remove credentials')}
          </button>
        </p>
      ) : (
        <p>{L('Noch kein Zugang hinterlegt.', 'No credentials stored yet.')}</p>
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
        <button type="submit">{L('Zugang speichern', 'Save credentials')}</button>
      </form>
      <div className="row">
        <label className="inline">
          {L('Monat', 'Month')}
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
          {L('Übertragen', 'Transfer')}
        </button>
      </div>
      <ErrorText text={error} />
      <h3>{L('Ergebnisprotokoll', 'Result log')}</h3>
      {log.data && log.data.transfers.length === 0 && (
        <p>{L('Noch keine Übertragung.', 'No transfer yet.')}</p>
      )}
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
                    {m.periods > 0 &&
                      L(` (${String(m.periods)} Einträge)`, ` (${String(m.periods)} entries)`)}
                    {m.message && ` – ${transferMessage(m.message)}`}
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
