// Offene Rückfragen als Karten: „Stimmt“ bestätigt, „Korrigieren“ öffnet das Tagesprotokoll.
import { promptMessage } from '@timelog/app-core';
import type { Prompt } from '@timelog/shared';
import { useState } from 'react';
import { useBackend, useT } from '../context.js';
import { promptKey } from '../usePrompts.js';

export function Prompts({
  prompts,
  today,
  onOpenDay,
  onOpenWeek,
  onDone,
}: {
  prompts: Prompt[];
  today: string;
  onOpenDay: (date: string) => void;
  onOpenWeek: (date: string) => void;
  onDone: () => void;
}) {
  const backend = useBackend();
  const tr = useT();
  const { t } = tr;
  const [error, setError] = useState<string>();
  if (prompts.length === 0) return null;

  const run = (action: () => Promise<unknown>) => {
    setError(undefined);
    void action().then(onDone, () => {
      setError(t('error.generic'));
    });
  };

  const confirm = (p: Prompt) => {
    if (p.kind === 'end_confirm') {
      run(() => backend.api.corrections.confirmSession(p.payload.sessionId));
    } else if (p.kind === 'end_missing' && p.payload.end) {
      const time = p.payload.end;
      run(() =>
        backend.api.corrections.correct(p.payload.date, {
          field: 'end',
          time,
          reason: t('prompt.reason'),
        }),
      );
    }
  };

  return (
    <section className="prompts" aria-label={t('prompt.region')}>
      {prompts.map((p) => {
        const { title, body } = promptMessage(p, tr, today);
        const id = `prompt-${promptKey(p).replace(/[^\w-]/g, '-')}`;
        const canConfirm =
          p.kind === 'end_confirm' || (p.kind === 'end_missing' && !!p.payload.end);
        return (
          <article key={promptKey(p)} className="card prompt" aria-labelledby={id}>
            <h2 id={id}>{title}</h2>
            <p>{body}</p>
            <div className="actions">
              {p.kind === 'week_review' ? (
                <button
                  type="button"
                  className="primary"
                  aria-describedby={id}
                  onClick={() => {
                    onOpenWeek(p.payload.from);
                  }}
                >
                  {t('prompt.open')}
                </button>
              ) : (
                <>
                  {canConfirm && (
                    <button
                      type="button"
                      className="primary"
                      aria-describedby={id}
                      onClick={() => {
                        confirm(p);
                      }}
                    >
                      {t('prompt.yes')}
                    </button>
                  )}
                  <button
                    type="button"
                    aria-describedby={id}
                    onClick={() => {
                      onOpenDay(p.payload.date);
                    }}
                  >
                    {t('prompt.correct')}
                  </button>
                </>
              )}
              <button
                type="button"
                aria-describedby={id}
                onClick={() => {
                  run(() => backend.api.prompts.dismiss(p.kind, p.ref));
                }}
              >
                {t('prompt.later')}
              </button>
            </div>
          </article>
        );
      })}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
