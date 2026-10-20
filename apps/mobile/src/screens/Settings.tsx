// Einstellungen: Konto, Arbeitsnetze, Automatik (Android: Netz/Akku/WLAN-Name, iOS: Kurzbefehl/
// Geofence), Sollzeiten, Benachrichtigungen, Geräte, Datenauskunft und Löschen.
import type { DeviceResponse, NetworksResponse, Settings } from '@timelog/shared';
import { useEffect, useState } from 'react';
import type { GeofenceStatus } from '../../modules/timelog-native';
import { Body, Button, Field, Notice, Screen, Section, ToggleRow } from '../ui/components';
import { useMobile } from '../ui/context';
import { LoginForm, ProfileForm } from './forms';

type Msg = { tone: 'success' | 'error' | 'warning' | 'info'; text: string } | null;

export function SettingsScreen() {
  const { t } = useMobile();
  return (
    <Screen title={t.m('settings.title')}>
      <AccountSection />
      <NetworkSection />
      <DetectionSection />
      <Section title={t.m('settings.profile')}>
        <ProfileForm />
      </Section>
      <NotificationSection />
      <DevicesSection />
      <PrivacySection />
    </Screen>
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
          <Button
            key={n.id}
            variant="secondary"
            label={t.m('settings.removeNetwork', { label: n.label })}
            onPress={() => core.removeNetwork(n.id)}
          />
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
          if (!CLOCK.test(from) || !CLOCK.test(to)) {
            setMsg({ tone: 'error', text: t.m('log.invalidTime') });
            return;
          }
          await set({ quietHours: { from, to } });
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
