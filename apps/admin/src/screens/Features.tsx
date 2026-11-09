import type { OrgFeatures } from '@timelog/shared';
import { useState } from 'react';
import { L, errorText } from '../texts.js';
import { ErrorText, useAdmin, useLoad } from '../ui.js';

const LABELS: Record<keyof OrgFeatures, { label: string; hint: string }> = {
  projects: {
    label: L('Projekte und Tätigkeiten', 'Projects and activities'),
    hint: L(
      'Mitglieder ordnen Arbeitszeit Firmenprojekten zu. Auswertung nur als Summe.',
      'Members assign working time to company projects. Reports show totals only.',
    ),
  },
  calendar: {
    label: L('Kalender-Anbindung erlauben', 'Allow calendar connection'),
    hint: L(
      'Mitglieder dürfen ihren eigenen Kalender (nur lesend) verbinden. Admins sehen keine Termine.',
      'Members may connect their own calendar (read-only). Admins cannot see any appointments.',
    ),
  },
  homeOfficeReport: {
    label: L('Homeoffice-Tage je Monat für Admins', 'Home office days per month for admins'),
    hint: L(
      'Zeigt Admins nur die Anzahl der Homeoffice-Tage je Monat und Person. Vorher die Mitglieder informieren; jeder Abruf steht im Audit-Log.',
      'Shows admins only the number of home office days per month and person. Inform members beforehand; every view is recorded in the audit log.',
    ),
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
        notify(
          `${LABELS[key].label}: ${value ? L('eingeschaltet', 'turned on') : L('ausgeschaltet', 'turned off')}.`,
        );
        features.reload();
      },
      (err: unknown) => {
        setError(errorText(err));
      },
    );
  };

  return (
    <fieldset className="card">
      <legend>{L('Funktionen', 'Features')}</legend>
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
