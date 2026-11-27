import { formatClock } from '@timelog/app-core';
import { useEffect, useRef, useState } from 'react';
import type { AppState } from '../backend.js';
import { useBackend, useT } from '../context.js';
import { refreshProfile } from '../profile.js';
import { LoginForm } from './LoginForm.js';
import { AddCurrentNetwork } from './NetworkStep.js';
import { SyncLine } from './Status.js';
import { TargetForm } from './TargetForm.js';

// Erst erklären, dann anmelden: Wer weiß, was erfasst wird (und was nicht), meldet sich eher an.
const STEPS = [
  'setup.explain',
  'setup.account',
  'setup.network',
  'setup.target',
  'setup.test',
] as const;
const EXPLAIN = 0;
const ACCOUNT = 1;
const NETWORK = 2;
const TARGET = 3;
const TEST = 4;
const DEFAULT_WEEK: [number, number, number, number, number, number, number] = [
  0, 480, 480, 480, 480, 480, 0,
];

export function Setup({
  state,
  onFinished,
  reload,
}: {
  state: AppState;
  onFinished: () => void;
  reload: () => void;
}) {
  const backend = useBackend();
  const tr = useT();
  const { t } = tr;
  // Schon angemeldet (Einrichtung unterbrochen): Erklärung und Anmeldung sind erledigt.
  const first = state.loggedIn ? NETWORK : EXPLAIN;
  const [step, setStep] = useState(first);
  const heading = useRef<HTMLHeadingElement>(null);

  // Fokus auf die Überschrift jedes Schritts (Screenreader und Tastatur).
  useEffect(() => {
    heading.current?.focus();
  }, [step]);

  const next = () => {
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  };
  const back = () => {
    setStep((s) => Math.max(s - 1, first));
  };
  const finish = async () => {
    await backend.finishSetup();
    onFinished();
  };

  const key = STEPS[step] ?? 'setup.explain';
  return (
    <main className="screen">
      <p className="muted">{t('setup.step', { n: step + 1, total: STEPS.length })}</p>
      <h1 ref={heading} tabIndex={-1}>
        {t(key)}
      </h1>
      {step === EXPLAIN && <p>{t('setup.explainText')}</p>}
      {step === ACCOUNT && (
        <LoginForm
          defaultUrl={
            state.baseUrl ?? (import.meta.env.VITE_DEFAULT_SERVER as string | undefined) ?? ''
          }
          onDone={() => {
            void refreshProfile(backend).catch(() => undefined);
            reload();
            next();
          }}
        />
      )}
      {step === NETWORK && <AddCurrentNetwork />}
      {step === TARGET && (
        <TargetForm
          initialState="BE"
          initialWeek={DEFAULT_WEEK}
          timezone={state.tracker.timezone}
          onSaved={next}
        />
      )}
      {step === TEST && (
        <div className="stack">
          <p>{t('setup.testText')}</p>
          <ul>
            <li>
              {state.tracker.bootReported
                ? t('setup.testBoot', {
                    time: formatClock(state.tracker.bootTime, state.tracker.timezone),
                  })
                : t('setup.testBootPending')}
            </li>
            <li>{t(state.tracker.active ? 'setup.testActive' : 'setup.testInactive')}</li>
            <li>{t(state.tracker.networkId ? 'setup.testNetwork' : 'setup.testNoNetwork')}</li>
            <li>
              <SyncLine state={state} />
            </li>
          </ul>
        </div>
      )}
      <div className="actions">
        {step > first && (
          <button type="button" onClick={back}>
            {t('action.back')}
          </button>
        )}
        {step !== ACCOUNT && step < STEPS.length - 1 && (
          <button type="button" className={step === TARGET ? '' : 'primary'} onClick={next}>
            {t(step === NETWORK || step === TARGET ? 'setup.skip' : 'action.next')}
          </button>
        )}
        {step === STEPS.length - 1 && (
          <button type="button" className="primary" onClick={() => void finish()}>
            {t('action.finish')}
          </button>
        )}
      </div>
    </main>
  );
}
