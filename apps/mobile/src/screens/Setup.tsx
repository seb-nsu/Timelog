// Einrichtungsassistent: Konto (oder „Nur lokal“), Sollzeiten, Erkennung, Benachrichtigungen, Erklärung.
import { useState } from 'react';
import { Body, Button, Notice, Screen, Section } from '../ui/components';
import { useMobile } from '../ui/context';
import { LoginForm, ProfileForm } from './forms';
import { DetectionSection, NetworkSection } from './Settings';

const TOTAL = 5;

export function SetupScreen() {
  const { core, state, t, go, actions } = useMobile();
  const [step, setStep] = useState(0);
  const [notify, setNotify] = useState<boolean | null>(null);
  const next = () => {
    setStep(Math.min(step + 1, TOTAL - 1));
  };
  const back = () => {
    setStep(Math.max(step - 1, 0));
  };
  const caps = state.capabilities;

  return (
    <Screen title={t.m('setup.title')}>
      <Body muted>{t.m('setup.step', { n: step + 1, total: TOTAL })}</Body>

      {step === 0 ? (
        <Section title={t.m('setup.welcome')}>
          <Body>{t.m('setup.welcomeText')}</Body>
          {state.account === 'none' ? (
            <>
              <LoginForm onDone={next} />
              <Button
                variant="secondary"
                label={t.m('setup.localOnly')}
                onPress={async () => {
                  await core.useLocalOnly();
                  next();
                }}
              />
            </>
          ) : (
            <>
              <Notice tone="success">
                {state.account === 'loggedIn'
                  ? t.m('settings.loggedIn', { url: state.baseUrl ?? '' })
                  : t.m('settings.localOnly')}
              </Notice>
              <Button label={t.m('setup.next')} onPress={next} />
            </>
          )}
        </Section>
      ) : null}

      {step === 1 ? (
        <Section title={t.m('setup.profile')}>
          <ProfileForm onSaved={next} />
        </Section>
      ) : null}

      {step === 2 ? (
        <>
          <Section title={t.m('setup.detect')}>
            <Body>
              {caps.platform === 'ios' ? t.m('setup.detectIos') : t.m('setup.detectAndroid')}
            </Body>
          </Section>
          <NetworkSection />
          <DetectionSection />
        </>
      ) : null}

      {step === 3 ? (
        <Section title={t.m('setup.notifications')}>
          <Body>{t.m('setup.notificationsText')}</Body>
          <Button
            label={t.m('setup.allowNotifications')}
            onPress={async () => {
              setNotify(await actions.requestNotifications());
            }}
          />
          {notify !== null ? (
            <Notice tone={notify ? 'success' : 'info'}>
              {notify ? t.m('common.yes') : t.m('common.no')}
            </Notice>
          ) : null}
        </Section>
      ) : null}

      {step === 4 ? (
        <Section title={t.m('setup.explain')}>
          <Body>{t.m('setup.explainText')}</Body>
          <Button
            testID="setup-finish"
            label={t.m('setup.finish')}
            onPress={async () => {
              await core.finishSetup();
              go({ name: 'today' });
            }}
          />
        </Section>
      ) : null}

      {step > 0 && step < TOTAL - 1 ? (
        <Button testID="setup-next" label={t.m('setup.next')} onPress={next} />
      ) : null}
      {step > 0 ? <Button variant="secondary" label={t.m('setup.back')} onPress={back} /> : null}
    </Screen>
  );
}
