import { formatClock, formatDate, reviewItems } from '@timelog/app-core';
import type { WorkDay } from '@timelog/rules';
import { useBackend, useT } from '../context.js';

export function Review({ days }: { days: WorkDay[] }) {
  const backend = useBackend();
  const tr = useT();
  const { t } = tr;
  const items = reviewItems(days);
  const locale = tr.locale === 'en' ? 'en-GB' : 'de-DE';

  return (
    <main className="screen">
      <h1>{t('nav.review')}</h1>
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
              <li key={item.sessionId} className="card">
                <h2>
                  {formatDate(item.date, locale)} · {label}
                </h2>
                <ul className="warnings">
                  {item.warnings.map((w) => (
                    <li key={w}>{tr.warning(w)}</li>
                  ))}
                </ul>
                {item.needsDecision && (
                  <div className="actions">
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
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
