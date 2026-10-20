import { type Locale, pickLocale, useNow, useTranslator } from '@timelog/app-core';
import { localDate } from '@timelog/rules';
import { useState } from 'react';
import type { DesktopBackend } from './backend.js';
import { BackendContext, TranslatorContext } from './context.js';
import { DayLog } from './screens/DayLog.js';
import { Leave } from './screens/Leave.js';
import { LoginForm } from './screens/LoginForm.js';
import { Prompts } from './screens/Prompts.js';
import { Reports } from './screens/Reports.js';
import { Review } from './screens/Review.js';
import { Settings } from './screens/Settings.js';
import { Setup } from './screens/Setup.js';
import { Status } from './screens/Status.js';
import { Week } from './screens/Week.js';
import { useDesktop } from './useDesktop.js';
import { usePrompts } from './usePrompts.js';
import { useReminders } from './useReminders.js';

type Page = 'status' | 'log' | 'review' | 'week' | 'leave' | 'reports' | 'settings';
const PAGES: readonly Page[] = ['status', 'log', 'review', 'week', 'leave', 'reports', 'settings'];

export function App({
  backend,
  clock,
  locale,
}: {
  backend: DesktopBackend;
  clock?: () => number;
  /** Ohne Angabe gilt die Systemsprache. */
  locale?: Locale;
}) {
  const translator = useTranslator(
    locale ?? pickLocale(typeof navigator === 'undefined' ? undefined : navigator.language),
  );
  const now = useNow(60_000, clock);
  const { state, profile, data, days, reload } = useDesktop(backend, now);
  const [page, setPage] = useState<Page>('status');
  // Ziel beim Öffnen aus einer Rückfrage; der Schlüssel setzt die Ansicht auf dieses Datum
  const [target, setTarget] = useState<{ date: string; n: number }>();
  const { t } = translator;
  const active = state?.loggedIn === true && state.setupDone;
  const tz = state?.tracker.timezone;
  useReminders(backend, active ? days : [], profile, now, tz, translator);
  const online = active && state.sync.state !== 'needsLogin';
  const { prompts, refresh } = usePrompts(backend, online, tz, translator, clock);

  const open = (p: Page, date?: string) => {
    setPage(p);
    setTarget(date ? { date, n: (target?.n ?? 0) + 1 } : undefined);
  };

  let content;
  if (!state) {
    content = <p role="status">…</p>;
  } else if (!state.loggedIn || !state.setupDone) {
    content = <Setup state={state} onFinished={reload} reload={reload} />;
  } else {
    const zone = state.tracker.timezone;
    const today = localDate(Date.parse(now), zone);
    const reviewCount = days.length > 0 ? days.filter((d) => d.status === 'unchecked').length : 0;
    const changed = () => {
      reload();
      refresh();
    };
    content = (
      <>
        <nav aria-label={t('app.title')}>
          {PAGES.map((p) => (
            <button
              key={p}
              type="button"
              aria-current={page === p ? 'page' : undefined}
              onClick={() => {
                open(p);
              }}
            >
              {t(`nav.${p}`)}
              {p === 'review' && reviewCount > 0 && <span className="badge"> {reviewCount}</span>}
            </button>
          ))}
        </nav>
        {state.sync.state === 'needsLogin' && (
          <section className="card" aria-labelledby="relogin">
            <h2 id="relogin">{t('sync.needsLogin')}</h2>
            <LoginForm defaultUrl={state.baseUrl ?? ''} onDone={reload} />
          </section>
        )}
        <Prompts
          prompts={prompts}
          today={today}
          onOpenDay={(date) => {
            open('log', date);
          }}
          onOpenWeek={(date) => {
            open('week', date);
          }}
          onDone={changed}
        />
        {page === 'status' && <Status state={state} days={days} now={now} />}
        {page === 'log' && (
          <DayLog
            key={target ? `d${String(target.n)}` : 'log'}
            days={days}
            events={data.events}
            today={today}
            tz={zone}
            initialDate={target?.date}
          />
        )}
        {page === 'review' && <Review days={days} today={today} tz={zone} onChanged={changed} />}
        {page === 'week' && (
          <Week
            key={target ? `w${String(target.n)}` : 'week'}
            localDays={days}
            profile={profile}
            today={today}
            tz={zone}
            initialDate={target?.date}
            onOpenDay={(date) => {
              open('log', date);
            }}
            onChanged={changed}
          />
        )}
        {page === 'leave' && <Leave today={today} />}
        {page === 'reports' && <Reports today={today} />}
        {page === 'settings' && (
          <Settings state={state} profile={profile} onLogout={reload} onSaved={reload} />
        )}
      </>
    );
  }

  return (
    <BackendContext.Provider value={backend}>
      <TranslatorContext.Provider value={translator}>{content}</TranslatorContext.Provider>
    </BackendContext.Provider>
  );
}
