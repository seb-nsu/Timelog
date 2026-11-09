import { type Locale, pickLocale, reviewItems, useNow, useTranslator } from '@timelog/app-core';
import { localDate } from '@timelog/rules';
import { useEffect, useState } from 'react';
import type { DesktopBackend } from './backend.js';
import { BackendContext, TranslatorContext } from './context.js';
import { Absence } from './screens/Absence.js';
import { LoginForm } from './screens/LoginForm.js';
import { Prompts } from './screens/Prompts.js';
import { Settings } from './screens/Settings.js';
import { Setup } from './screens/Setup.js';
import { Status } from './screens/Status.js';
import { Times, type TimesTarget } from './screens/Times.js';
import { useDesktop } from './useDesktop.js';
import { useExtras } from './useExtras.js';
import { usePrompts } from './usePrompts.js';
import { useReminders } from './useReminders.js';

// Vier Bereiche: Heute (inkl. „Zu prüfen“), Zeiten (Woche/Monat, Tag, Export), Abwesenheit, Einstellungen.
type Page = 'today' | 'times' | 'absence' | 'settings';
const PAGES: readonly Page[] = ['today', 'times', 'absence', 'settings'];

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
  const [page, setPage] = useState<Page>('today');
  // Ziel beim Öffnen aus einer Rückfrage; der Schlüssel setzt die Ansicht auf dieses Datum
  const [target, setTarget] = useState<TimesTarget & { n: number }>();
  const [extrasVersion, setExtrasVersion] = useState(0);
  const { t } = translator;
  // Tray-Menü in derselben Sprache wie die Oberfläche
  useEffect(() => {
    void backend
      .setTrayLabels({
        open: t('tray.open'),
        start: t('action.start'),
        stop: t('action.stop'),
        quit: t('tray.quit'),
      })
      .catch(() => undefined);
  }, [backend, t]);
  // Sprache dem Server mitteilen (für Exporte; die Desktop-App sendet kein Accept-Language)
  const signedIn = state?.loggedIn === true;
  useEffect(() => {
    if (!signedIn) return;
    void backend.api.devices.update({ locale: translator.locale }).catch(() => undefined);
  }, [backend, signedIn, translator.locale]);
  const active = state?.loggedIn === true && state.setupDone;
  const tz = state?.tracker.timezone;
  useReminders(backend, active ? days : [], profile, now, tz, translator);
  const online = active && state.sync.state !== 'needsLogin';
  const extras = useExtras(backend, active, extrasVersion);
  const { prompts, refresh } = usePrompts(backend, online, tz, translator, clock);

  const open = (p: Page, goal?: TimesTarget) => {
    setPage(p);
    setTarget(goal ? { ...goal, n: (target?.n ?? 0) + 1 } : undefined);
  };

  let content;
  if (!state) {
    content = <p role="status">…</p>;
  } else if (!state.loggedIn || !state.setupDone) {
    content = <Setup state={state} onFinished={reload} reload={reload} />;
  } else {
    const zone = state.tracker.timezone;
    const today = localDate(Date.parse(now), zone);
    const reviewCount = reviewItems(days).length;
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
              {p === 'today' && reviewCount > 0 && <span className="badge"> {reviewCount}</span>}
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
            open('times', { view: 'day', date });
          }}
          onOpenWeek={(date) => {
            open('times', { view: 'period', date });
          }}
          onDone={changed}
        />
        {page === 'today' && (
          <Status
            state={state}
            days={days}
            now={now}
            extras={extras}
            onChanged={changed}
            onOpenDay={(date) => {
              open('times', { view: 'day', date });
            }}
          />
        )}
        {page === 'times' && (
          <Times
            key={target ? `t${String(target.n)}` : 'times'}
            days={days}
            events={data.events}
            profile={profile}
            today={today}
            tz={zone}
            extras={extras}
            initial={target}
            onChanged={changed}
          />
        )}
        {page === 'absence' && <Absence today={today} profile={profile} onChanged={reload} />}
        {page === 'settings' && (
          <Settings
            state={state}
            profile={profile}
            extras={extras}
            onLogout={reload}
            onSaved={reload}
            onExtrasChanged={() => {
              setExtrasVersion((v) => v + 1);
            }}
          />
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
