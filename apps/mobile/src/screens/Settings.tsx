// Einstellungen in fünf Bereichen statt einer langen Liste: Arbeitszeit (Sollzeiten), Erkennung
// (Arbeitsnetze, Automatik: Android Netz/Akku/WLAN-Name, iOS Kurzbefehl/Geofence), Benachrichtigungen,
// Zusatzfunktionen (Projekte, Kalender, Homeoffice; standardmäßig aus) und Konto (Geräte, Datenauskunft, Löschen).
import type { DeviceResponse, NetworksResponse, Settings } from '@timelog/shared';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import type { GeofenceStatus } from '../../modules/timelog-native';
import { Body, Button, Choice, Field, Notice, Screen, Section, ToggleRow } from '../ui/components';
import { useMobile } from '../ui/context';
import { CalendarSection, NetworkExtras, ProjectsSection } from './Extras';
import { LoginForm, ProfileForm } from './forms';

type Msg = { tone: 'success' | 'error' | 'warning' | 'info'; text: string } | null;

type Part = 'work' | 'detection' | 'notifications' | 'extras' | 'account';
const PARTS: readonly Part[] = ['work', 'detection', 'notifications', 'extras', 'account'];

export function SettingsScreen() {
  const { t } = useMobile();
  const [part, setPart] = useState<Part>('work');
  return (
    <Screen title={t.m('settings.title')}>
      <Choice<Part>
        label={t.t('settings.sections')}
        value={part}
        onChange={setPart}
        options={PARTS.map((p) => ({ value: p, label: t.t(`settings.section.${p}`) }))}
      />
      {part === 'work' ? (
        <Section title={t.m('settings.profile')}>
          <ProfileForm />
        </Section>
      ) : null}
      {part === 'detection' ? (
        <>
          <NetworkSection />
          <DetectionSection />
        </>
      ) : null}
      {part === 'notifications' ? <NotificationSection /> : null}
      {part === 'extras' ? <ExtrasSection /> : null}
      {part === 'account' ? (
        <>
          <AccountSection />
          <DevicesSection />
          <PrivacySection />
        </>
      ) : null}
    </Screen>
  );
}

/** Zusatzfunktionen: Projekte (eigener Schalter bzw. von der Firma), Kalender und Homeoffice. */
function ExtrasSection() {
  const { core, state, t } = useMobile();
  const set = (patch: Partial<Settings>) => core.saveSettings({ ...state.settings, ...patch });
  return (
    <>
      <Body muted>{t.t('extras.hint')}</Body>
      <ProjectsSection />
      <Section title={t.t('extras.calendar')}>
        <ToggleRow
          label={t.t('extras.calendar')}
          hint={t.t('extras.calendarHint')}
          value={state.settings.calendar}
          onValueChange={(v) => set({ calendar: v })}
        />
      </Section>
      {state.settings.calendar ? <CalendarSection /> : null}
      <Section title={t.t('extras.homeOffice')}>
        <ToggleRow
          label={t.t('extras.homeOffice')}
          hint={t.t('extras.homeOfficeHint')}
          value={state.settings.homeOffice}
          onValueChange={(v) => set({ homeOffice: v })}
        />
      </Section>
    </>
  );
}

function AccountSection() {
  const { core, state, t } = useMobile();
  return (
    <Section title={t.m('settings.account')}>
      {state.account === 'loggedIn' ? (
        <>
          <Body>{t.m('settings.loggedIn', { url: state.baseUrl ?? '' })}</Body>
          {state.totpSetupRequired ? (
            <Notice tone="warning">{t.m('setup.totpSetup')}</Notice>
          ) : null}
          <Button
            variant="secondary"
            label={t.m('settings.syncNow')}
            onPress={() => core.sync(true)}
          />
          <Button
            variant="secondary"
            label={t.m('settings.logout')}
            onPress={() => core.logout()}
          />
        </>
      ) : (
        <>
          <Body>
            {state.account === 'localOnly' ? t.m('settings.localOnly') : t.m('settings.noAccount')}
          </Body>
          <LoginForm />
        </>
      )}
    </Section>
  );
}

export function NetworkSection() {
  const { core, state, t, version } = useMobile();
  const [nets, setNets] = useState<NetworksResponse | undefined>();
  const [label, setLabel] = useState('');
  const [msg, setMsg] = useState<Msg>(null);

  useEffect(() => {
    let current = true;
    void core.networks().then((n) => {
      if (current) setNets(n);
    });
    return () => {
      current = false;
    };
  }, [core, version]);

  if (state.account === 'none') return null;

  const add = async () => {
    try {
      const res = await core.addCurrentNetwork(label);
      if (res.status === 'none') {
        setMsg({ tone: 'error', text: t.m('settings.networkNone') });
        return;
      }
      setMsg(
        res.weak
          ? { tone: 'warning', text: t.m('settings.networkWeak') }
          : { tone: 'success', text: t.m('settings.networkAdded', { label: label.trim() || '—' }) },
      );
      setLabel('');
    } catch {
      setMsg({ tone: 'error', text: t.m('common.error') });
    }
  };

  const list = nets?.networks ?? [];
  return (
    <Section title={t.m('settings.networks')}>
      {list.length === 0 ? <Body muted>{t.m('settings.noNetworks')}</Body> : null}
      {list.map((n) =>
        n.scope === 'org' ? (
          <Body key={n.id}>{t.m('settings.orgNetwork', { label: n.label })}</Body>
        ) : (
          <View key={n.id} style={{ gap: 8 }}>
            <NetworkExtras network={n} />
            <Button
              variant="secondary"
              label={t.m('settings.removeNetwork', { label: n.label })}
              onPress={() => core.removeNetwork(n.id)}
            />
          </View>
        ),
      )}
      {state.capabilities.networkDetection ? (
        <>
          <Field
            label={t.m('settings.networkLabel')}
            value={label}
            onChangeText={setLabel}
            maxLength={100}
          />
          <Button
            label={t.m('settings.addNetwork')}
            hint={t.m('settings.addNetworkHint')}
            onPress={add}
          />
          <Body muted>{t.m('settings.addNetworkHint')}</Body>
        </>
      ) : null}
      {msg ? <Notice tone={msg.tone}>{msg.text}</Notice> : null}
    </Section>
  );
}

export function DetectionSection() {
  const { core, state, t, version } = useMobile();
  const caps = state.capabilities;
  const [battery, setBattery] = useState<{ ok: boolean; vendor: string } | null>(null);
  const [geo, setGeo] = useState<GeofenceStatus | null>(null);
  const [fallback, setFallback] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);

  useEffect(() => {
    let current = true;
    if (caps.batteryOptimization) {
      void Promise.all([
        core.native.isIgnoringBatteryOptimizations(),
        core.native.manufacturer(),
      ]).then(([ok, vendor]) => {
        if (current) setBattery({ ok, vendor: vendor.toLowerCase() });
      });
    }
    if (caps.geofence) {
      void core.native.geofenceStatus().then((g) => {
        if (current) setGeo(g);
      });
    }
    return () => {
      current = false;
    };
  }, [core, caps.batteryOptimization, caps.geofence, version]);

  const setTrigger = (key: keyof Settings['triggers'], value: boolean) =>
    core.saveSettings({
      ...state.settings,
      triggers: { ...state.settings.triggers, [key]: value },
    });

  const enableSsid = async (on: boolean) => {
    if (on && (await core.native.requestSsidPermission()) !== 'granted') {
      setMsg({ tone: 'error', text: t.m('settings.ssidDenied') });
      return;
    }
    await core.setSsidEnabled(on);
  };

  const enableGeofence = async () => {
    const g = await core.native.enableGeofenceHere(150, fallback ? 'region' : 'monitor');
    setGeo(g);
    if (!g.active) {
      setMsg({ tone: 'error', text: t.m('settings.geofenceDenied') });
      return;
    }
    await setTrigger('geofence', true);
  };

  return (
    <Section title={t.m('settings.automatic')}>
      {caps.networkDetection ? (
        <>
          <ToggleRow
            label={t.m('settings.triggerNetwork')}
            value={state.settings.triggers.network}
            onValueChange={(v) => setTrigger('network', v)}
          />
          <Button
            variant="secondary"
            label={t.m('settings.checkNow')}
            onPress={() => core.native.checkNow()}
          />
        </>
      ) : null}
      {caps.ssidOption ? (
        <ToggleRow
          label={t.m('settings.ssid')}
          hint={t.m('settings.ssidHint')}
          value={state.ssidEnabled}
          onValueChange={enableSsid}
        />
      ) : null}
      {caps.batteryOptimization && battery ? (
        battery.ok ? (
          <Notice tone="success">{t.m('settings.batteryOk')}</Notice>
        ) : (
          <>
            <Notice tone="warning">{t.m('settings.batteryHint')}</Notice>
            {battery.vendor.includes('samsung') ? (
              <Body>{t.m('settings.batterySamsung')}</Body>
            ) : null}
            <Button
              variant="secondary"
              label={t.m('settings.batteryOpen')}
              onPress={() => core.native.openBatterySettings()}
            />
          </>
        )
      ) : null}
      {caps.shortcuts ? (
        <>
          <ToggleRow
            label={t.m('settings.triggerNetwork')}
            value={state.settings.triggers.network}
            onValueChange={(v) => setTrigger('network', v)}
          />
          <Body>{t.m('settings.shortcut')}</Body>
          <Body muted>{t.m('settings.shortcutSteps')}</Body>
        </>
      ) : null}
      {caps.geofence ? (
        <>
          <Body>{t.m('settings.geofence')}</Body>
          <Body muted>{t.m('settings.geofenceHint')}</Body>
          {geo?.active ? (
            <>
              <Notice tone="success">
                {t.m('settings.geofenceActive', { engine: geo.engine ?? '' })}
              </Notice>
              <Button
                variant="secondary"
                label={t.m('settings.geofenceOff')}
                onPress={async () => {
                  await core.native.disableGeofence();
                  setGeo(await core.native.geofenceStatus());
                  await setTrigger('geofence', false);
                }}
              />
            </>
          ) : (
            <>
              <ToggleRow
                label={t.m('settings.geofenceFallback')}
                value={fallback}
                onValueChange={setFallback}
              />
              <Button label={t.m('settings.geofenceHere')} onPress={enableGeofence} />
            </>
          )}
        </>
      ) : null}
      {msg ? <Notice tone={msg.tone}>{msg.text}</Notice> : null}
    </Section>
  );
}

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

function NotificationSection() {
  const { core, state, t } = useMobile();
  const n = state.settings.notifications;
  const [from, setFrom] = useState(n.quietHours.from);
  const [to, setTo] = useState(n.quietHours.to);
  const [weekTime, setWeekTime] = useState(n.weekReview.time);
  const [msg, setMsg] = useState<Msg>(null);
  const set = (patch: Partial<Settings['notifications']>) =>
    core.saveSettings({ ...state.settings, notifications: { ...n, ...patch } });

  return (
    <Section title={t.m('settings.notifications')}>
      {(['forgotEnd', 'over10h', 'breakViolation', 'confirmDay'] as const).map((key) => (
        <ToggleRow
          key={key}
          label={t.m(`settings.notify.${key}`)}
          value={n[key]}
          onValueChange={(v) => set({ [key]: v })}
        />
      ))}
      <ToggleRow
        label={t.t('settings.reminder.confirmEnd')}
        value={n.confirmEnd}
        onValueChange={(v) => set({ confirmEnd: v })}
      />
      <ToggleRow
        label={t.t('settings.weekReviewOn')}
        value={n.weekReview.enabled}
        onValueChange={(v) => set({ weekReview: { ...n.weekReview, enabled: v } })}
      />
      {n.weekReview.enabled ? (
        <>
          <Choice<string>
            label={t.t('settings.weekReviewDay')}
            value={String(n.weekReview.weekday)}
            onChange={(v) => {
              void set({ weekReview: { ...n.weekReview, weekday: Number(v) } });
            }}
            options={[1, 2, 3, 4, 5, 6, 0].map((d) => ({
              value: String(d),
              label: t.weekday(d),
            }))}
          />
          <Field
            label={t.t('settings.weekReviewTime')}
            value={weekTime}
            onChangeText={setWeekTime}
            inputMode="numeric"
          />
        </>
      ) : null}
      <Field
        label={t.m('settings.quietFrom')}
        value={from}
        onChangeText={setFrom}
        inputMode="numeric"
      />
      <Field label={t.m('settings.quietTo')} value={to} onChangeText={setTo} inputMode="numeric" />
      <Button
        variant="secondary"
        label={t.m('settings.saveNotifications')}
        onPress={async () => {
          if (!CLOCK.test(from) || !CLOCK.test(to) || !CLOCK.test(weekTime)) {
            setMsg({ tone: 'error', text: t.m('log.invalidTime') });
            return;
          }
          await set({ quietHours: { from, to }, weekReview: { ...n.weekReview, time: weekTime } });
          setMsg({ tone: 'success', text: t.m('settings.saved') });
        }}
      />
      {msg ? <Notice tone={msg.tone}>{msg.text}</Notice> : null}
    </Section>
  );
}

function DevicesSection() {
  const { core, state, t, version } = useMobile();
  const [devices, setDevices] = useState<DeviceResponse[]>([]);
  useEffect(() => {
    let current = true;
    if (state.account === 'loggedIn') {
      core.devices().then(
        (list) => {
          if (current) setDevices(list.filter((d) => !d.revokedAt));
        },
        () => undefined,
      );
    }
    return () => {
      current = false;
    };
  }, [core, state.account, version]);
  if (state.account !== 'loggedIn' || devices.length === 0) return null;
  return (
    <Section title={t.m('settings.devices')}>
      {devices.map((d) =>
        d.id === state.deviceId ? (
          <Body key={d.id}>{t.m('settings.thisDevice', { name: d.name })}</Body>
        ) : (
          <Button
            key={d.id}
            variant="secondary"
            label={t.m('settings.revoke', { name: `${d.name} (${d.os})` })}
            onPress={async () => {
              await core.revokeDevice(d.id);
              setDevices(devices.filter((x) => x.id !== d.id));
            }}
          />
        ),
      )}
    </Section>
  );
}

function PrivacySection() {
  const { core, state, t, actions, go } = useMobile();
  const [password, setPassword] = useState('');
  const [confirmWipe, setConfirmWipe] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);

  const exportData = async () => {
    try {
      const data = await core.dataExport();
      await actions.shareFile(
        'timelog-daten.json',
        'application/json',
        JSON.stringify(data, null, 2),
      );
    } catch {
      setMsg({ tone: 'error', text: t.m('common.error') });
    }
  };

  return (
    <Section title={t.m('settings.privacy')}>
      {state.account !== 'none' ? (
        <Button variant="secondary" label={t.m('settings.dataExport')} onPress={exportData} />
      ) : null}
      {state.account === 'loggedIn' ? (
        <>
          <Field
            label={t.m('settings.deletePassword')}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
          />
          <Button
            variant="danger"
            label={t.m('settings.deleteConfirm')}
            disabled={password.length === 0}
            onPress={async () => {
              try {
                const mode = await core.deleteAccount(password);
                setMsg({
                  tone: 'success',
                  text:
                    mode === 'anonymized' ? t.m('settings.anonymized') : t.m('settings.deleted'),
                });
              } catch {
                setMsg({ tone: 'error', text: t.m('common.error') });
              }
            }}
          />
        </>
      ) : null}
      {state.account === 'localOnly' ? (
        confirmWipe ? (
          <>
            <Notice tone="warning">{t.m('settings.wipeConfirm')}</Notice>
            <Button
              variant="danger"
              label={t.m('settings.wipe')}
              onPress={() => core.wipeLocal()}
            />
            <Button
              variant="secondary"
              label={t.m('common.cancel')}
              onPress={() => {
                setConfirmWipe(false);
              }}
            />
          </>
        ) : (
          <Button
            variant="danger"
            label={t.m('settings.wipe')}
            onPress={() => {
              setConfirmWipe(true);
            }}
          />
        )
      ) : null}
      <Button
        variant="secondary"
        label={t.m('settings.setupAgain')}
        onPress={() => {
          go({ name: 'setup' });
        }}
      />
      {msg ? <Notice tone={msg.tone}>{msg.text}</Notice> : null}
    </Section>
  );
}
