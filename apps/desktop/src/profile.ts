// Profil (Bundesland, Sollzeiten, Abwesenheiten) vom Server holen und lokal zwischenspeichern.
import { type Profile, remindersFromAccount } from '@timelog/app-core';
import { addDays, localDate } from '@timelog/rules';
import type { DesktopBackend } from './backend.js';

export async function refreshProfile(backend: DesktopBackend, now = Date.now()): Promise<Profile> {
  const [settings, target] = await Promise.all([
    backend.api.settings.get(),
    backend.api.targetHours.get(),
  ]);
  const today = localDate(now, settings.timezone);
  const { absences } = await backend.api.absences.list({
    from: addDays(today, -200),
    to: addDays(today, 200),
  });
  const profile: Profile = {
    state: settings.state,
    timezone: settings.timezone,
    targetSchedule: target.schedule,
    absences: absences.map(({ date, kind, minutes }) => ({ date, kind, minutes })),
    reminders: remindersFromAccount(settings.settings.notifications),
  };
  await backend.setProfile(profile);
  return profile;
}
