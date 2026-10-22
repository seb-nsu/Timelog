// Zusatzfunktionen (Projekte, Kalender, Arbeitsort/Homeoffice) sind standardmäßig unsichtbar.
// Projekte schaltet der Nutzer bzw. bei Firmenkonten der Admin; Kalender braucht zusätzlich die Freigabe der Firma.
import type { Settings } from '@timelog/shared';
import type { DesktopBackend } from './backend.js';
import { useLoad } from './useLoad.js';

export interface Extras {
  projects: boolean;
  calendar: boolean;
  homeOffice: boolean;
  /** Kontoeinstellungen, solange geladen; zum Umschalten der Zusatzfunktionen. */
  settings: Settings | undefined;
  /** Kalender ist in der Firma freigegeben bzw. auf dem Server eingerichtet. */
  calendarAllowed: boolean;
  reload: () => void;
}

/** Lädt erst, wenn `active` (angemeldet und eingerichtet); `version` lädt neu. */
export function useExtras(backend: DesktopBackend, active: boolean, version = 0): Extras {
  const when = <T>(load: () => Promise<T>) => (active ? load() : Promise.resolve(undefined));
  const settings = useLoad(
    () => when(() => backend.api.settings.get()),
    [backend, active, version],
  );
  const projects = useLoad(
    () => when(() => backend.api.projects.list()),
    [backend, active, version],
  );
  const calendar = useLoad(
    () => when(() => backend.api.calendar.status()),
    [backend, active, version],
  );
  const s = settings.data?.settings;
  const calendarAllowed = calendar.data?.allowed === true;
  return {
    projects: projects.data?.enabled === true,
    calendar: s?.calendar === true && calendarAllowed,
    homeOffice: s?.homeOffice === true,
    settings: s,
    calendarAllowed,
    reload: () => {
      settings.reload();
      projects.reload();
      calendar.reload();
    },
  };
}
