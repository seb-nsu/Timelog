// Projekte, Arbeitsort, Kalender und Auswertung. Alles braucht ein Konto (die Aufteilung rechnet der
// Server mit @timelog/rules); ohne Konto bzw. ohne eingeschaltete Zusatzfunktion bleiben die Bereiche weg.
import {
  formatClock,
  formatDate,
  formatEuro,
  formatMinutes,
  monthNames,
  parseKeywords,
  projectName,
  selectableProjects,
  sortShares,
  suggestionKey,
  suggestionRange,
} from '@timelog/app-core';
import { type WorkLocation, localDate } from '@timelog/rules';
import {
  type ApiClient,
  ApiError,
  type CalendarProviderId,
  type NetworksResponse,
} from '@timelog/shared';
import { useCallback, useEffect, useState } from 'react';
import {
  Body,
  Button,
  Choice,
  Field,
  Notice,
  Row,
  Screen,
  Section,
  ToggleRow,
} from '../ui/components';
import { useMobile } from '../ui/context';

type Msg = { tone: 'success' | 'error' | 'info'; text: string } | null;
const NONE = 'none';
const LOCATIONS: readonly WorkLocation[] = ['office', 'home', 'other'];

/** Lädt vom Server, solange ein Konto angemeldet ist; Fehler (z. B. 403) liefern undefined. */
function useServer<T>(
  load: (api: ApiClient) => Promise<T>,
  deps: readonly unknown[],
): { data: T | undefined; reload: () => void; set: (v: T) => void } {
  const { core, state, version } = useMobile();
  const [data, setData] = useState<T>();
  const [tick, setTick] = useState(0);
  const online = state.account === 'loggedIn';
  const run = useCallback(load, deps);
  useEffect(() => {
    let current = true;
    if (!online) {
      setData(undefined);
      return;
    }
    core
      .api()
      .then(run)
      .then(
        (d) => {
          if (current) setData(d);
        },
        () => {
          if (current) setData(undefined);
        },
      );
    return () => {
      current = false;
    };
  }, [core, online, run, tick, version]);
  const reload = useCallback(() => {
    setTick((v) => v + 1);
  }, []);
  return { data, reload, set: setData };
}

// ── Tagesprotokoll ────────────────────────────────────────────────────────────

export function DayExtrasSection({ date }: { date: string }) {
  const { core, state, t } = useMobile();
  const [msg, setMsg] = useState<Msg>(null);
  const list = useServer((api) => api.projects.list(), []);
  const day = useServer((api) => api.projects.day(date), [date]);
  const year = Number(date.slice(0, 4));
  const showLocation = state.settings.homeOffice;
  const locs = useServer(
    (api) => (showLocation ? api.locations.year(year) : Promise.resolve(undefined)),
    [year, showLocation],
  );
  const projects = list.data?.projects ?? [];
  const loc = locs.data?.days.find((d) => d.date === date);
  const locked = day.data?.locked === true;
  const tz = state.timezone;

  const run = async (task: (api: ApiClient) => Promise<void>) => {
    try {
      await task(await core.api());
      setMsg({ tone: 'success', text: t.m('common.save') });
    } catch {
      setMsg({ tone: 'error', text: t.m('common.error') });
    }
  };

  return (
    <>
      {list.data?.enabled && day.data ? (
        <Section title={t.t('projects.day')}>
          {sortShares(day.data.day.items, projects).map((i) => (
            <Row
              key={i.projectId ?? NONE}
              label={projectName(projects, i.projectId, t.t('projects.unassigned'))}
              value={`${formatMinutes(i.netMinutes)}${i.manual ? ` (${t.t('projects.manual')})` : ''}`}
            />
          ))}
          {day.data.day.items.some((i) => i.topUpMinutes > 0) ? (
            <Body muted>
              {t.t('projects.topUp', {
                minutes: day.data.day.items.reduce((s, i) => s + i.topUpMinutes, 0),
              })}
            </Body>
          ) : null}
          {locked ? <Notice>{t.t('projects.locked')}</Notice> : null}
          {!locked
            ? day.data.segments.map((s) => (
                <Choice<string>
                  key={s.from}
                  label={t.t('projects.assign', {
                    from: formatClock(s.from, tz),
                    to: formatClock(s.to, tz),
                  })}
                  value={s.projectId ?? NONE}
                  options={[
                    { value: NONE, label: t.t('projects.unassigned') },
                    ...selectableProjects(projects, s.projectId).map((p) => ({
                      value: p.id,
                      label: p.name,
                    })),
                  ]}
                  onChange={(v) => {
                    void run(async (api) => {
                      day.set(
                        await api.projects.assign(date, {
                          from: s.from,
                          to: s.to,
                          projectId: v === NONE ? null : v,
                        }),
                      );
                    });
                  }}
                />
              ))
            : null}
        </Section>
      ) : null}
      {locs.data ? (
        <Section title={t.t('location.title')}>
          <Choice<string>
            label={t.t('location.title')}
            value={loc?.source === 'manual' ? (loc.location ?? NONE) : NONE}
            options={[
              {
                value: NONE,
                label:
                  loc?.source === 'auto' && loc.location
                    ? `${t.t('location.auto')}: ${t.t(`location.${loc.location}`)}`
                    : t.t('location.auto'),
              },
              ...LOCATIONS.map((l) => ({ value: l, label: t.t(`location.${l}`) })),
            ]}
            onChange={(v) => {
              if (locked) return;
              void run(async (api) => {
                await api.locations.set(date, v === NONE ? null : (v as WorkLocation));
                locs.reload();
              });
            }}
          />
          {loc?.source === 'manual' ? <Body muted>{t.t('location.manual')}</Body> : null}
        </Section>
      ) : null}
      {msg ? <Notice tone={msg.tone}>{msg.text}</Notice> : null}
    </>
  );
}

// ── Zu prüfen ─────────────────────────────────────────────────────────────────

export function CalendarSuggestionsSection() {
  const { core, state, days, now, t } = useMobile();
  const [hidden, setHidden] = useState<string[]>([]);
  const [msg, setMsg] = useState<Msg>(null);
  const today = localDate(Date.parse(now), state.timezone);
  const status = useServer((api) => api.calendar.status(), []);
  const connected = (status.data?.connections.length ?? 0) > 0;
  const sug = useServer(
    (api) =>
      connected
        ? api.calendar.suggestions(suggestionRange(today))
        : Promise.resolve({ gaps: [], absences: [] }),
    [today, connected],
  );
  const gaps = (sug.data?.gaps ?? []).filter((g) => !hidden.includes(suggestionKey(g)));
  const absences = (sug.data?.absences ?? []).filter((a) => !hidden.includes(a.date));
  if (gaps.length === 0 && absences.length === 0) {
    return msg ? <Notice tone={msg.tone}>{msg.text}</Notice> : null;
  }
  const hide = (key: string) => {
    setHidden((h) => [...h, key]);
  };
  return (
    <Section title={t.t('suggest.title')}>
      {gaps.map((g) => {
        const text = `${formatDate(g.date, t.tag)} · ${t.t(
          g.kind === 'break' ? 'suggest.break' : 'suggest.gap',
          { from: formatClock(g.from, state.timezone), to: formatClock(g.to, state.timezone) },
        )}`;
        return (
          <Section key={suggestionKey(g)}>
            <Body>{text}</Body>
            <Button
              label={t.t('suggest.wasMeeting')}
              hint={text}
              onPress={async () => {
                await core.manualRange('manual_work', g.from, g.to);
                hide(suggestionKey(g));
              }}
            />
            <Button
              variant="secondary"
              label={t.t('suggest.dismiss')}
              hint={text}
              onPress={() => {
                hide(suggestionKey(g));
              }}
            />
          </Section>
        );
      })}
      {absences.map((a) => {
        const text = `${formatDate(a.date, t.tag)} · ${t.t('suggest.absence')}`;
        return (
          <Section key={a.date}>
            <Body>{text}</Body>
            <Button
              label={t.t('suggest.addAbsence')}
              hint={text}
              onPress={async () => {
                try {
                  const minutes = days.find((d) => d.date === a.date)?.targetMinutes ?? 0;
                  await core.saveAbsences(a.date, a.date, [
                    { date: a.date, kind: 'vacation', minutes },
                  ]);
                  hide(a.date);
                  setMsg({ tone: 'success', text: t.m('common.save') });
                } catch {
                  setMsg({ tone: 'error', text: t.m('common.error') });
                }
              }}
            />
            <Button
              variant="secondary"
              label={t.t('suggest.dismiss')}
              hint={text}
              onPress={() => {
                hide(a.date);
              }}
            />
          </Section>
        );
      })}
      {msg ? <Notice tone={msg.tone}>{msg.text}</Notice> : null}
    </Section>
  );
}

// ── Einstellungen ─────────────────────────────────────────────────────────────

export function ProjectsSection() {
  const { core, state, t } = useMobile();
  const list = useServer((api) => api.projects.list(), []);
  const settings = useServer((api) => api.settings.get(), []);
  const [name, setName] = useState('');
  const [customer, setCustomer] = useState('');
  const [keywords, setKeywords] = useState('');
  const [msg, setMsg] = useState<Msg>(null);
  if (state.account !== 'loggedIn') {
    return (
      <Section title={t.t('projects.title')}>
        <Body muted>{t.t('calendar.needsAccount')}</Body>
      </Section>
    );
  }
  const data = list.data;
  if (!data) return null;

  const run = async (task: (api: ApiClient) => Promise<unknown>) => {
    try {
      await task(await core.api());
      setMsg({ tone: 'success', text: t.m('common.save') });
      list.reload();
    } catch {
      setMsg({ tone: 'error', text: t.m('common.error') });
    }
  };

  return (
    <Section title={t.t('projects.title')}>
      {data.canManage ? (
        <ToggleRow
          label={t.t('projects.enable')}
          hint={t.t('projects.enableHint')}
          value={data.enabled}
          disabled={!settings.data}
          onValueChange={(enabled) =>
            run(async (api) => {
              if (!settings.data) return;
              settings.set(
                await api.settings.put({
                  settings: { ...settings.data.settings, projects: enabled },
                }),
              );
            })
          }
        />
      ) : (
        <Body>{data.enabled ? t.t('projects.orgManaged') : t.t('projects.off')}</Body>
      )}
      {data.enabled ? (
        <>
          {data.projects.length === 0 ? <Body muted>{t.t('projects.none')}</Body> : null}
          {data.projects.map((p) =>
            data.canManage ? (
              <Button
                key={p.id}
                variant="secondary"
                label={`${t.t(p.archived ? 'projects.restore' : 'projects.archive')}: ${p.name}`}
                onPress={() => run((api) => api.projects.update(p.id, { archived: !p.archived }))}
              />
            ) : (
              <Body key={p.id}>{p.name}</Body>
            ),
          )}
          {data.canManage ? (
            <>
              <Field
                label={t.t('projects.name')}
                value={name}
                onChangeText={setName}
                maxLength={100}
              />
              <Field
                label={t.t('projects.customer')}
                value={customer}
                onChangeText={setCustomer}
                maxLength={100}
              />
              <Field label={t.t('projects.keywords')} value={keywords} onChangeText={setKeywords} />
              <Button
                label={t.t('projects.add')}
                disabled={name.trim() === ''}
                onPress={() =>
                  run(async (api) => {
                    await api.projects.create({
                      name: name.trim(),
                      ...(customer.trim() ? { customer: customer.trim() } : {}),
                      keywords: parseKeywords(keywords),
                    });
                    setName('');
                    setCustomer('');
                    setKeywords('');
                  })
                }
              />
            </>
          ) : null}
        </>
      ) : null}
      {msg ? <Notice tone={msg.tone}>{msg.text}</Notice> : null}
    </Section>
  );
}

export function CalendarSection() {
  const { core, state, t, actions } = useMobile();
  const status = useServer((api) => api.calendar.status(), []);
  const [msg, setMsg] = useState<Msg>(null);
  if (state.account !== 'loggedIn') return null;
  const data = status.data;
  if (!data) return null;

  const run = async (task: (api: ApiClient) => Promise<string>) => {
    try {
      setMsg({ tone: 'success', text: await task(await core.api()) });
      status.reload();
    } catch (e) {
      const code = e instanceof ApiError ? e.code : '';
      setMsg({ tone: 'error', text: code ? t.t('calendar.error', { code }) : t.m('common.error') });
    }
  };
  const name = (p: CalendarProviderId) => t.t(`calendar.${p}`);

  return (
    <Section title={t.t('calendar.title')}>
      <Body muted>{t.t('calendar.hint')}</Body>
      {!data.allowed ? <Body>{t.t('calendar.notAllowed')}</Body> : null}
      {data.allowed
        ? data.providers.map(({ provider, configured }) => {
            const conn = data.connections.find((c) => c.provider === provider);
            if (!configured) {
              return (
                <Row key={provider} label={name(provider)} value={t.t('calendar.notConfigured')} />
              );
            }
            return (
              <Section key={provider} title={name(provider)}>
                {conn ? (
                  <Body>
                    {conn.status === 'error'
                      ? t.t('calendar.error', { code: conn.lastError ?? '?' })
                      : conn.lastSyncAt
                        ? t.t('calendar.connected', {
                            time: new Intl.DateTimeFormat(t.tag, {
                              dateStyle: 'short',
                              timeStyle: 'short',
                            }).format(new Date(conn.lastSyncAt)),
                          })
                        : t.t('calendar.never')}
                  </Body>
                ) : null}
                {conn ? (
                  <>
                    <Button
                      variant="secondary"
                      label={`${t.t('calendar.sync')}: ${name(provider)}`}
                      onPress={() =>
                        run(async (api) =>
                          t.t('calendar.synced', {
                            count: (await api.calendar.sync(provider)).entries,
                          }),
                        )
                      }
                    />
                    <Button
                      variant="danger"
                      label={`${t.t('calendar.disconnect')}: ${name(provider)}`}
                      onPress={() =>
                        run(async (api) => {
                          await api.calendar.disconnect(provider);
                          return t.t('calendar.disconnected');
                        })
                      }
                    />
                  </>
                ) : null}
                {!conn || conn.status === 'error' ? (
                  <Button
                    label={t.t('calendar.connect', { provider: name(provider) })}
                    onPress={() =>
                      run(async (api) => {
                        const { url } = await api.calendar.connect(provider);
                        await actions.openUrl(url);
                        return t.t('calendar.openHint');
                      })
                    }
                  />
                ) : null}
              </Section>
            );
          })
        : null}
      {msg ? <Notice tone={msg.tone}>{msg.text}</Notice> : null}
    </Section>
  );
}

/** Ort und Standardprojekt eines eigenen Netzes (nur mit Konto). */
export function NetworkExtras({ network }: { network: NetworksResponse['networks'][number] }) {
  const { core, state, t } = useMobile();
  const list = useServer((api) => api.projects.list(), []);
  if (state.account !== 'loggedIn') return null;
  const projects = list.data;
  return (
    <>
      {state.settings.homeOffice ? (
        <Choice<WorkLocation>
          label={t.t('location.ofNetwork', { label: network.label })}
          value={network.location}
          options={LOCATIONS.map((l) => ({ value: l, label: t.t(`location.${l}`) }))}
          onChange={(location) => {
            void core.updateNetwork(network.id, { location });
          }}
        />
      ) : null}
      {projects?.enabled ? (
        <Choice<string>
          label={`${t.t('projects.defaultProject')} (${network.label})`}
          value={network.defaultProjectId ?? NONE}
          options={[
            { value: NONE, label: t.t('projects.noDefault') },
            ...selectableProjects(projects.projects, network.defaultProjectId).map((p) => ({
              value: p.id,
              label: p.name,
            })),
          ]}
          onChange={(v) => {
            void core.updateNetwork(network.id, { defaultProjectId: v === NONE ? null : v });
          }}
        />
      ) : null}
    </>
  );
}

// ── Auswertung ────────────────────────────────────────────────────────────────

export function ReportsScreen() {
  const { core, state, now, t, actions } = useMobile();
  const today = localDate(Date.parse(now), state.timezone);
  const [from, setFrom] = useState(`${today.slice(0, 7)}-01`);
  const [to, setTo] = useState(today);
  const [year, setYear] = useState(Number(today.slice(0, 4)));
  const [msg, setMsg] = useState<Msg>(null);
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && from <= to;
  const list = useServer((api) => api.projects.list(), []);
  const enabled = list.data?.enabled === true;
  const report = useServer(
    (api) => (valid && enabled ? api.projects.report({ from, to }) : Promise.resolve(undefined)),
    [from, to, valid, enabled],
  );
  const showLocation = state.settings.homeOffice;
  const locs = useServer(
    (api) => (showLocation ? api.locations.year(year) : Promise.resolve(undefined)),
    [year, showLocation],
  );
  const months = monthNames(t.tag);

  const share = async (
    load: (api: ApiClient) => Promise<Blob>,
    name: string,
    format: 'csv' | 'pdf',
  ) => {
    try {
      const blob = await load(await core.api());
      await actions.shareFile(
        `${name}.${format}`,
        format === 'csv' ? 'text/csv' : 'application/pdf',
        blob,
      );
      setMsg({ tone: 'success', text: t.t('export.done') });
    } catch {
      setMsg({ tone: 'error', text: t.m('common.error') });
    }
  };

  return (
    <Screen title={t.t('nav.reports')}>
      {state.account !== 'loggedIn' ? <Body muted>{t.t('calendar.needsAccount')}</Body> : null}
      {enabled ? (
        <Section title={t.t('projects.report')}>
          <Field label={t.t('projects.from')} value={from} onChangeText={setFrom} maxLength={10} />
          <Field label={t.t('projects.to')} value={to} onChangeText={setTo} maxLength={10} />
          {report.data && report.data.totals.length === 0 ? (
            <Body muted>{t.t('projects.reportEmpty')}</Body>
          ) : null}
          {report.data?.totals.map((x) => (
            <Row
              key={x.projectId ?? NONE}
              label={x.name ?? t.t('projects.unassigned')}
              value={formatMinutes(x.netMinutes)}
            />
          ))}
          {report.data && report.data.customers.length > 0 ? (
            <Body>{t.t('projects.byCustomer')}</Body>
          ) : null}
          {report.data?.customers.map((c) => (
            <Row
              key={c.customer ?? NONE}
              label={c.customer ?? t.t('projects.noCustomer')}
              value={formatMinutes(c.netMinutes)}
            />
          ))}
          {(['csv', 'pdf'] as const).map((format) => (
            <Button
              key={format}
              variant="secondary"
              disabled={!valid}
              label={`${t.t(format === 'csv' ? 'export.csv' : 'export.pdf')}: ${t.t('projects.report')}`}
              onPress={() =>
                share(
                  (api) => api.projects.export({ from, to, format }),
                  `projekte_${from}_${to}`,
                  format,
                )
              }
            />
          ))}
        </Section>
      ) : null}
      {locs.data ? (
        <Section title={t.t('homeOffice.title', { year })}>
          <Button
            variant="secondary"
            label={t.t('homeOffice.prev')}
            onPress={() => {
              setYear(year - 1);
            }}
          />
          <Button
            variant="secondary"
            label={t.t('homeOffice.next')}
            disabled={year >= Number(today.slice(0, 4))}
            onPress={() => {
              setYear(year + 1);
            }}
          />
          <Body>{t.t('homeOffice.homeDays', { count: locs.data.summary.homeDays })}</Body>
          <Body>{t.t('homeOffice.officeDays', { count: locs.data.summary.officeDays })}</Body>
          <Body>{t.t('homeOffice.otherDays', { count: locs.data.summary.otherDays })}</Body>
          <Body>
            {t.t('homeOffice.amount', {
              amount: formatEuro(locs.data.summary.amountCents, t.tag),
              perDay: formatEuro(locs.data.allowance.perDayCents, t.tag),
              max: formatEuro(locs.data.allowance.maxPerYearCents, t.tag),
            })}
          </Body>
          <Body>{t.t('homeOffice.byMonth')}</Body>
          {locs.data.summary.homeDaysByMonth.map((n, i) =>
            n > 0 ? <Row key={months[i] ?? i} label={months[i] ?? ''} value={String(n)} /> : null,
          )}
          <Body muted>{t.t('homeOffice.basis', { basis: locs.data.allowance.legalBasis })}</Body>
          {(['csv', 'pdf'] as const).map((format) => (
            <Button
              key={format}
              variant="secondary"
              label={`${t.t(format === 'csv' ? 'export.csv' : 'export.pdf')}: ${t.t('homeOffice.title', { year })}`}
              onPress={() =>
                share(
                  (api) => api.locations.export({ year, format }),
                  `homeoffice_${String(year)}`,
                  format,
                )
              }
            />
          ))}
        </Section>
      ) : null}
      {msg ? <Notice tone={msg.tone}>{msg.text}</Notice> : null}
    </Screen>
  );
}
