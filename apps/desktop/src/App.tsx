import { type Locale, pickLocale, useNow, useTranslator } from '@timelog/app-core';
import { localDate } from '@timelog/rules';
import { useState } from 'react';
import type { DesktopBackend } from './backend.js';
import { BackendContext, TranslatorContext } from './context.js';
import { DayLog } from './screens/DayLog.js';
import { LoginForm } from './screens/LoginForm.js';
import { Review } from './screens/Review.js';
import { Settings } from './screens/Settings.js';
import { Setup } from './screens/Setup.js';
import { Status } from './screens/Status.js';
import { useDesktop } from './useDesktop.js';

type Page = 'status' | 'log' | 'review' | 'settings';
const PAGES: readonly Page[] = ['status', 'log', 'review', 'settings'];

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
  const { t } = translator;

  let content;
  if (!state) {
    content = <p role="status">…</p>;
  } else if (!state.loggedIn || !state.setupDone) {
    content = <Setup state={state} onFinished={reload} reload={reload} />;
  } else {
    const tz = state.tracker.timezone;
    const today = localDate(Date.parse(now), tz);
    const reviewCount = days.length > 0 ? days.filter((d) => d.status === 'unchecked').length : 0;
    content = (
      <>
        <nav aria-label={t('app.title')}>
          {PAGES.map((p) => (
            <button
              key={p}
              type="button"
              aria-current={page === p ? 'page' : undefined}
              onClick={() => {
                setPage(p);
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
        {page === 'status' && <Status state={state} days={days} now={now} />}
        {page === 'log' && <DayLog days={days} events={data.events} today={today} tz={tz} />}
        {page === 'review' && <Review days={days} />}
        {page === 'settings' && <Settings state={state} profile={profile} onLogout={reload} />}
      </>
    );
  }

  return (
    <BackendContext.Provider value={backend}>
      <TranslatorContext.Provider value={translator}>{content}</TranslatorContext.Provider>
    </BackendContext.Provider>
  );
}
