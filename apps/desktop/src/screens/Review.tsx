// „Zu prüfen“ als Karte auf Heute: Sitzungen mit Prüfhinweisen, bei Bedarf Bestätigen/Verwerfen,
// sonst ein Link auf den Tag. Mit Kalender-Anbindung kommen Vorschläge aus dem Kalender dazu.
import { formatClock, formatDate, reviewItems } from '@timelog/app-core';
import type { WorkDay } from '@timelog/rules';
import { useId } from 'react';
import { useBackend, useT } from '../context.js';
import { CalendarSuggestions } from './CalendarSuggestions.js';

export function Review({
  days,
  today,
  tz,
  calendar,
  onChanged,
  onOpenDay,
}: {
  days: WorkDay[];
  today: string;
  tz: string;
  calendar: boolean;
  onChanged: () => void;
  onOpenDay: (date: string) => void;
}) {
  const backend = useBackend();
  const tr = useT();
  const { t } = tr;
  const id = useId();
  const items = reviewItems(days);
  const locale = tr.locale === 'en' ? 'en-GB' : 'de-DE';

  return (
    <section className="card" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>
        {t('review.title')}
        {items.length > 0 && <span className="badge"> ({items.length})</span>}
      </h2>
      {items.length === 0 ? (
        <p>{t('review.empty')}</p>
      ) : (
        <ul className="cards">
          {items.map((item) => {
            const label = t('review.session', {
              from: formatClock(item.from, item.tz),
              to: item.to ? formatClock(item.to, item.tz) : '…',
            });
            return (
              <li key={item.sessionId} className="review-item">
                <h3>
                  {formatDate(item.date, locale)} · {label}
                </h3>
                <ul className="warnings">
                  {item.warnings.map((w) => (
                    <li key={w}>{tr.warning(w)}</li>
                  ))}
                </ul>
                <div className="actions">
                  {item.needsDecision && (
                    <>
                      <button
                        type="button"
                        className="primary"
                        aria-label={`${t('action.confirm')}: ${label}`}
                        onClick={() => void backend.decideSession(item.sessionId, true)}
                      >
                        {t('action.confirm')}
                      </button>
                      <button
                        type="button"
                        aria-label={`${t('action.reject')}: ${label}`}
                        onClick={() => void backend.decideSession(item.sessionId, false)}
                      >
                        {t('action.reject')}
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    className="link"
                    onClick={() => {
                      onOpenDay(item.date);
                    }}
                  >
                    {t('times.open', { date: formatDate(item.date, locale) })}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {calendar && <CalendarSuggestions days={days} today={today} tz={tz} onChanged={onChanged} />}
    </section>
  );
}
