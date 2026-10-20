import type { OrgFeatures } from '@timelog/shared';
import { useState } from 'react';
import { errorText } from '../texts.js';
import { ErrorText, useAdmin, useLoad } from '../ui.js';

const LABELS: Record<keyof OrgFeatures, { label: string; hint: string }> = {
  projects: {
    label: 'Projekte und Tätigkeiten',
    hint: 'Mitglieder ordnen Arbeitszeit Firmenprojekten zu. Auswertung nur als Summe.',
  },
  calendar: {
    label: 'Kalender-Anbindung erlauben',
    hint: 'Mitglieder dürfen ihren eigenen Kalender (nur lesend) verbinden. Admins sehen keine Termine.',
  },
  homeOfficeReport: {
    label: 'Homeoffice-Tage je Monat für Admins',
    hint: 'Zeigt Admins nur die Anzahl der Homeoffice-Tage je Monat und Person. Vorher die Mitglieder informieren; jeder Abruf steht im Audit-Log.',
  },
};

/** Funktionen der Organisation ein- und ausschalten. */
export function Features() {
  const { api, notify } = useAdmin();
  const features = useLoad(() => api.org.features.get(), [api]);
  const [error, setError] = useState<string>();
  const data = features.data;

  const toggle = (key: keyof OrgFeatures, value: boolean) => {
    setError(undefined);
    api.org.features.put({ [key]: value }).then(
      () => {
        notify(`${LABELS[key].label}: ${value ? 'eingeschaltet' : 'ausgeschaltet'}.`);
        features.reload();
      },
      (err: unknown) => {
        setError(errorText(err));
      },
    );
  };

  return (
    <fieldset className="card">
      <legend>Funktionen</legend>
      <ErrorText text={features.error ?? error} />
      {data &&
        (Object.keys(LABELS) as (keyof OrgFeatures)[]).map((key) => (
          <label key={key} className="inline">
            <input
              type="checkbox"
              checked={data[key]}
              aria-describedby={`feature-${key}`}
              onChange={(e) => {
                toggle(key, e.target.checked);
              }}
            />
            {LABELS[key].label}
            <span id={`feature-${key}`} className="muted">
              {' '}
              – {LABELS[key].hint}
            </span>
          </label>
        ))}
    </fieldset>
  );
}
