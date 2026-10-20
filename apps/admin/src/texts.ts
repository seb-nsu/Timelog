// Texte und Darstellung des Web-Admins (Deutsch).
import { createTranslator, formatMinutes } from '@timelog/app-core';
import { ApiError, type Role } from '@timelog/shared';

export const tr = createTranslator('de');

export const ROLE_LABELS: Record<Role, string> = {
  user: 'Mitglied',
  manager: 'Manager',
  admin: 'Admin',
};

export const APPROVAL_LABELS = {
  none: 'nicht eingereicht',
  submitted: 'eingereicht',
  approved: 'freigegeben',
  rejected: 'zurückgewiesen',
} as const;

export const AUDIT_LABELS: Record<string, string> = {
  'org.create': 'Organisation angelegt',
  'config.update': 'Einstellungen geändert',
  'member.invite': 'Person eingeladen',
  'invitation.accept': 'Einladung angenommen',
  'invitation.revoke': 'Einladung widerrufen',
  'member.provision': 'Konto per SSO angelegt',
  'member.update': 'Rolle oder Team geändert',
  'member.deactivate': 'Mitglied deaktiviert',
  'team.create': 'Team angelegt',
  'team.update': 'Team geändert',
  'team.delete': 'Team gelöscht',
  'network.create': 'Firmen-Netz hinzugefügt',
  'network.delete': 'Firmen-Netz entfernt',
  'target_hours.update': 'Sollzeiten geändert',
  'day.correct': 'Tag durch Admin korrigiert',
  'approval.submit': 'Monat eingereicht',
  'approval.approve': 'Monat freigegeben',
  'approval.reject': 'Monat zurückgewiesen',
  'approval.reopen': 'Freigabe zurückgesetzt',
  'export.create': 'Export erstellt',
  'leave.request': 'Urlaub/Abbau beantragt',
  'leave.approve': 'Antrag genehmigt',
  'leave.reject': 'Antrag abgelehnt',
  'leave.cancel': 'Antrag storniert',
  'leave.settings': 'Urlaubseinstellungen geändert',
  'leave.profile': 'Urlaubsanspruch geändert',
  'leave.adjust': 'Urlaubskonto gebucht',
  'overtime.book': 'Überstunden gebucht',
  'payroll.config': 'Lohn-Einstellungen geändert',
  'payroll.member': 'Personalnummer geändert',
  'payroll.export': 'Lohn-Export erstellt',
  'payroll.credentials': 'Personio-Zugang gespeichert',
  'payroll.credentials.delete': 'Personio-Zugang entfernt',
  'payroll.transfer': 'An Personio übertragen',
};

export const LEAVE_KIND_LABELS = { vacation: 'Urlaub', overtime: 'Überstundenabbau' } as const;
export const LEAVE_STATUS_LABELS = {
  pending: 'offen',
  approved: 'genehmigt',
  rejected: 'abgelehnt',
  cancelled: 'storniert',
} as const;
export const CALENDAR_KIND_LABELS = {
  vacation: 'Urlaub',
  overtime: 'Überstundenabbau',
  absent: 'abwesend',
} as const;
export const BOOKING_KIND_LABELS = {
  payout: 'Auszahlung',
  cap: 'Kappung',
  correction: 'Korrektur',
} as const;
export const PAYROLL_FORMAT_LABELS = {
  datev_lodas: 'DATEV LODAS (ASCII-Import)',
  datev_lug: 'DATEV Lohn und Gehalt (ASCII-Import)',
  lexware: 'Lexware lohn+gehalt (Import-ASCII)',
} as const;
export const TRANSFER_LABELS = {
  ok: 'erfolgreich',
  partial: 'teilweise erfolgreich',
  failed: 'fehlgeschlagen',
  transferred: 'übertragen',
  skipped: 'übersprungen',
} as const;

export const RULE_LABELS: Record<string, string> = {
  shutdownBonusMin: 'Aufschlag beim Herunterfahren (Minuten)',
  restartWindowMin: 'Neustart-Fenster (Minuten)',
  updateRestartWindowMin: 'Neustart-Fenster bei Updates (Minuten)',
  netGraceMin: 'Karenzzeit bei Netz-Verlust (Minuten)',
  standbyBreakMin: 'Inaktivität am Laptop ab … Minuten = Pause',
  maxStandbyMin: 'Inaktivität ab … Minuten = Sitzungsende',
  maxBreakMin: 'Lücke ab … Minuten trennt Sitzungen',
  maxSessionH: 'Höchstdauer einer Sitzung (Stunden)',
};

const ERRORS: Record<string, string> = {
  invalid_credentials: 'E-Mail oder Passwort ist falsch.',
  totp_required: 'Bitte den Code aus der Authenticator-App eingeben.',
  invalid_totp: 'Der Code ist falsch oder abgelaufen.',
  email_not_verified: 'Bitte zuerst die E-Mail-Adresse bestätigen.',
  account_deactivated: 'Dieses Konto wurde deaktiviert.',
  sso_required: 'Deine Organisation verlangt die Anmeldung über SSO.',
  rate_limited: 'Zu viele Versuche. Bitte kurz warten.',
  invalid_token: 'Der Link ist ungültig oder abgelaufen.',
  email_in_use: 'Für diese Adresse gibt es bereits ein Konto.',
  last_admin: 'Die Organisation braucht mindestens einen Admin.',
  slug_taken: 'Dieser Kurzname ist schon vergeben.',
  not_submitted: 'Der Monat ist nicht (mehr) eingereicht.',
  self_approval: 'Den eigenen Monat kann man nicht selbst freigeben.',
  invalid_manager: 'Als Teamleitung kommen nur Manager oder Admins in Frage.',
  issuer_must_be_https: 'Die Issuer-Adresse muss mit https:// beginnen.',
  not_a_member: 'Dieses Konto gehört nicht zu der Organisation.',
  subject_mismatch: 'Das IdP-Konto passt nicht zum hinterlegten Konto.',
  domain_not_allowed: 'Die E-Mail-Domain ist für SSO nicht freigegeben.',
  email_missing: 'Der IdP hat keine bestätigte E-Mail-Adresse geliefert.',
  invalid_response: 'Die Antwort des IdP war ungültig.',
  idp_error: 'Der IdP hat die Anmeldung abgebrochen.',
  not_configured: 'SSO ist für diese Organisation nicht eingerichtet.',
  forbidden: 'Dafür fehlt die Berechtigung.',
  not_found: 'Nicht gefunden.',
  cannot_deactivate_self: 'Das eigene Konto lässt sich hier nicht deaktivieren.',
  reason_required: 'Bitte eine Begründung angeben.',
  overlapping_request: 'Für diesen Zeitraum gibt es schon einen Antrag oder eine Abwesenheit.',
  month_locked: 'Der Monat ist freigegeben. Nur ein Admin kann ihn dafür wieder öffnen.',
  no_workdays: 'Im Zeitraum liegt kein Arbeitstag.',
  already_started: 'Der Zeitraum hat schon begonnen.',
  not_pending: 'Der Antrag ist nicht mehr offen.',
  not_cancellable: 'Der Antrag lässt sich nicht stornieren.',
  use_own_cancel: 'Eigene Anträge bitte in der App stornieren.',
  self_booking: 'Buchungen am eigenen Konto sind nicht erlaubt.',
  managed_by_admin: 'Das pflegt der Admin der Organisation.',
  nothing_to_export: 'Kein Mitglied mit freigegebenem Monat und Personalnummer.',
  payroll_config_incomplete:
    'Lohn-Einstellungen unvollständig (Lohnart bzw. Berater-/Mandantennummer).',
  personio_not_configured: 'Bitte zuerst den Personio-Zugang hinterlegen.',
};

export function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    return (
      ERRORS[err.code] ??
      `Fehler: ${err.code}${err.message !== err.code ? ` (${err.message})` : ''}`
    );
  }
  if (typeof err === 'string') return ERRORS[err] ?? `Fehler: ${err}`;
  return 'Der Server ist nicht erreichbar.';
}

const viewerTz = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Uhrzeit in der Zeitzone des Browsers. */
export function clock(iso: string | undefined): string {
  if (!iso) return '–';
  return new Intl.DateTimeFormat('de-DE', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: viewerTz,
  }).format(new Date(iso));
}

export function dateTime(iso: string): string {
  return new Intl.DateTimeFormat('de-DE', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: viewerTz,
  }).format(new Date(iso));
}

export const hours = (minutes: number): string => `${formatMinutes(minutes)} h`;

/** Vormonat als JJJJ-MM (Standard für Freigaben und Export). */
export function previousMonth(nowMs: number): string {
  const d = new Date(nowMs);
  const y = d.getFullYear();
  const m = d.getMonth(); // 0-basiert = Vormonat in 1-basierter Zählung
  return m === 0 ? `${String(y - 1)}-12` : `${String(y)}-${String(m).padStart(2, '0')}`;
}
