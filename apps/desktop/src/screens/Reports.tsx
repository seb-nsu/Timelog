// Auswertung: Projektzeiten je Projekt und Kunde, Homeoffice-Nachweis eines Jahres, CSV-Export.
// PDF gibt es in der Handy-App; der Desktop-Kern überträgt nur Text.
import { formatEuro, formatMinutes, monthNames } from '@timelog/app-core';
import { addDays } from '@timelog/rules';
import { type ReactNode, useId, useState } from 'react';
import { useBackend, useT } from '../context.js';
import type { Extras } from '../useExtras.js';
import { saveFile, useLoad } from '../useLoad.js';

/** Nur mit Zusatzfunktionen erreichbar (unter Zeiten). */
export function Reports({
  today,
  extras,
  back,
}: {
  today: string;
  extras: Extras;
  back?: ReactNode;
}) {
  const backend = useBackend();
  const tr = useT();
  const { t } = tr;
  const id = useId();
  const locale = tr.locale === 'en' ? 'en-GB' : 'de-DE';
  const [from, setFrom] = useState(`${today.slice(0, 7)}-01`);
  const [to, setTo] = useState(today);
  const [year, setYear] = useState(Number(today.slice(0, 4)));
  const [message, setMessage] = useState<string>();
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && from <= to;
  const list = useLoad(() => backend.api.projects.list(), [backend]);
  const report = useLoad(
    () =>
      valid && list.data?.enabled
        ? backend.api.projects.report({ from, to })
        : Promise.resolve(undefined),
    [backend, from, to, valid, list.data?.enabled],
  );
  const loc = useLoad(
    () => (extras.homeOffice ? backend.api.locations.year(year) : Promise.resolve(undefined)),
    [backend, year, extras.homeOffice],
  );
  const months = monthNames(locale);

  const exportCsv = async (load: () => Promise<Blob>, filename: string) => {
    try {
      saveFile(await (await load()).text(), filename);
      setMessage(t('export.done'));
    } catch {
      setMessage(t('error.generic'));
    }
  };

  return (
    <main className="screen">
      {back}
      <h1>{t('nav.reports')}</h1>
      {list.data?.enabled && (
        <section className="card" aria-labelledby={`${id}-projects`}>
          <h2 id={`${id}-projects`}>{t('projects.report')}</h2>
          <div className="actions">
            <label htmlFor={`${id}-from`}>{t('projects.from')}</label>
            <input
              id={`${id}-from`}
              type="date"
              value={from}
              max={to}
              onChange={(e) => {
                setFrom(e.target.value);
              }}
            />
            <label htmlFor={`${id}-to`}>{t('projects.to')}</label>
            <input
              id={`${id}-to`}
              type="date"
              value={to}
              min={from}
              max={addDays(today, 366)}
              onChange={(e) => {
                setTo(e.target.value);
              }}
            />
          </div>
          {report.data && report.data.totals.length === 0 && <p>{t('projects.reportEmpty')}</p>}
          {report.data && report.data.totals.length > 0 && (
            <>
              <table>
                <caption className="muted">
                  {from} – {to}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">{t('projects.name')}</th>
                    <th scope="col">{t('status.net')}</th>
                  </tr>
                </thead>
                <tbody>
                  {report.data.totals.map((x) => (
                    <tr key={x.projectId ?? 'none'}>
                      <th scope="row">{x.name ?? t('projects.unassigned')}</th>
                      <td>{formatMinutes(x.netMinutes)} h</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <h3>{t('projects.byCustomer')}</h3>
              <ul className="log">
                {report.data.customers.map((c) => (
                  <li key={c.customer ?? 'none'}>
                    {t('projects.share', {
                      name: c.customer ?? t('projects.noCustomer'),
                      time: formatMinutes(c.netMinutes),
                    })}
                  </li>
                ))}
              </ul>
            </>
          )}
          <button
            type="button"
            disabled={!valid}
            onClick={() =>
              void exportCsv(
                () => backend.api.projects.export({ from, to, format: 'csv' }),
                `projekte_${from}_${to}.csv`,
              )
            }
          >
            {t('export.csv')}
          </button>
        </section>
      )}

      {extras.homeOffice && (
        <section className="card" aria-labelledby={`${id}-ho`}>
          <div className="row">
            <button
              type="button"
              aria-label={t('homeOffice.prev')}
              onClick={() => {
                setYear(year - 1);
              }}
            >
              ‹
            </button>
            <h2 id={`${id}-ho`} aria-live="polite">
              {t('homeOffice.title', { year })}
            </h2>
            <button
              type="button"
              aria-label={t('homeOffice.next')}
              disabled={year >= Number(today.slice(0, 4))}
              onClick={() => {
                setYear(year + 1);
              }}
            >
              ›
            </button>
          </div>
          {loc.data && (
            <>
              <ul className="log">
                <li>{t('homeOffice.homeDays', { count: loc.data.summary.homeDays })}</li>
                <li>{t('homeOffice.officeDays', { count: loc.data.summary.officeDays })}</li>
                <li>{t('homeOffice.otherDays', { count: loc.data.summary.otherDays })}</li>
                <li>
                  {t('homeOffice.amount', {
                    amount: formatEuro(loc.data.summary.amountCents, locale),
                    perDay: formatEuro(loc.data.allowance.perDayCents, locale),
                    max: formatEuro(loc.data.allowance.maxPerYearCents, locale),
                  })}
                </li>
              </ul>
              <table>
                <caption>{t('homeOffice.byMonth')}</caption>
                <thead>
                  <tr>
                    {months.map((m) => (
                      <th key={m} scope="col">
                        {m}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    {loc.data.summary.homeDaysByMonth.map((n, i) => (
                      <td key={months[i] ?? i}>{n}</td>
                    ))}
                  </tr>
                </tbody>
              </table>
              <p className="muted">
                {t('homeOffice.basis', { basis: loc.data.allowance.legalBasis })}
              </p>
              <button
                type="button"
                onClick={() =>
                  void exportCsv(
                    () => backend.api.locations.export({ year, format: 'csv' }),
                    `homeoffice_${String(year)}.csv`,
                  )
                }
              >
                {t('export.csv')}
              </button>
            </>
          )}
        </section>
      )}
      {message && <p role="status">{message}</p>}
    </main>
  );
}
