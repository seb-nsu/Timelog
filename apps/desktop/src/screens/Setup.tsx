import { formatClock } from '@timelog/app-core';
import { useEffect, useRef, useState } from 'react';
import type { AppState } from '../backend.js';
import { useBackend, useT } from '../context.js';
import { refreshProfile } from '../profile.js';
import { LoginForm } from './LoginForm.js';
import { AddCurrentNetwork } from './NetworkStep.js';
import { SyncLine } from './Status.js';
import { TargetForm } from './TargetForm.js';

const STEPS = [
  'setup.account',
  'setup.network',
  'setup.target',
  'setup.explain',
  'setup.test',
] as const;
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
  const [step, setStep] = useState(state.loggedIn ? 1 : 0);
  const heading = useRef<HTMLHeadingElement>(null);

  // Fokus auf die Überschrift jedes Schritts (Screenreader und Tastatur).
  useEffect(() => {
    heading.current?.focus();
  }, [step]);

  const next = () => {
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  };
  const back = () => {
    setStep((s) => Math.max(s - 1, state.loggedIn ? 1 : 0));
  };
  const finish = async () => {
    await backend.finishSetup();
    onFinished();
  };

  const key = STEPS[step] ?? 'setup.account';
  return (
    <main className="screen">
      <p className="muted">{t('setup.step', { n: step + 1, total: STEPS.length })}</p>
      <h1 ref={heading} tabIndex={-1}>
        {t(key)}
      </h1>
      {step === 0 && (
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
      {step === 1 && <AddCurrentNetwork />}
      {step === 2 && (
        <TargetForm
          initialState="BE"
          initialWeek={DEFAULT_WEEK}
          timezone={state.tracker.timezone}
          onSaved={next}
        />
      )}
      {step === 3 && <p>{t('setup.explainText')}</p>}
      {step === 4 && (
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
        {step > (state.loggedIn ? 1 : 0) && (
          <button type="button" onClick={back}>
            {t('action.back')}
          </button>
        )}
        {step > 0 && step < STEPS.length - 1 && (
          <button type="button" className={step === 2 ? '' : 'primary'} onClick={next}>
            {t(step === 1 || step === 2 ? 'setup.skip' : 'action.next')}
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
