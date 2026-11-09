// Texte und Darstellung des Web-Admins (Deutsch und Englisch). Die Sprache folgt dem Browser.
import { type Locale, createTranslator, formatMinutes, pickLocale } from '@timelog/app-core';
import { ApiError, type Role } from '@timelog/shared';

/** Sprache des Web-Admins, einmal beim Laden aus der Browsersprache bestimmt. */
export const locale: Locale = pickLocale(
  typeof navigator === 'undefined' ? undefined : navigator.language,
);

/** Intl-Gebietsschema passend zur Sprache. */
export const intlLocale = locale === 'en' ? 'en-GB' : 'de-DE';

/** Text in der aktuellen Sprache: Deutsch ist führend, Englisch steht direkt daneben. */
export function L(de: string, en: string): string {
  return locale === 'en' ? en : de;
}

export const tr = createTranslator(locale);

/** Zweisprachige Tabelle auf die aktuelle Sprache abbilden. */
function pick<K extends string>(table: Record<K, readonly [string, string]>): Record<K, string> {
  const out = {} as Record<K, string>;
  for (const key of Object.keys(table) as K[]) {
    const [de, en] = table[key];
    out[key] = L(de, en);
  }
  return out;
}

export const ROLE_LABELS: Record<Role, string> = pick({
  user: ['Mitglied', 'Member'],
  manager: ['Manager', 'Manager'],
  admin: ['Admin', 'Admin'],
});

export const APPROVAL_LABELS = pick({
  none: ['nicht eingereicht', 'not submitted'],
  submitted: ['eingereicht', 'submitted'],
  approved: ['freigegeben', 'approved'],
  rejected: ['zurückgewiesen', 'rejected'],
});

export const AUDIT_LABELS: Record<string, string> = pick({
  'org.create': ['Organisation angelegt', 'Organisation created'],
  'config.update': ['Einstellungen geändert', 'Settings changed'],
  'member.invite': ['Person eingeladen', 'Person invited'],
  'invitation.accept': ['Einladung angenommen', 'Invitation accepted'],
  'invitation.revoke': ['Einladung widerrufen', 'Invitation revoked'],
  'member.provision': ['Konto per SSO angelegt', 'Account created via SSO'],
  'member.update': ['Rolle oder Team geändert', 'Role or team changed'],
  'member.deactivate': ['Mitglied deaktiviert', 'Member deactivated'],
  'team.create': ['Team angelegt', 'Team created'],
  'team.update': ['Team geändert', 'Team changed'],
  'team.delete': ['Team gelöscht', 'Team deleted'],
  'network.create': ['Firmen-Netz hinzugefügt', 'Company network added'],
  'network.delete': ['Firmen-Netz entfernt', 'Company network removed'],
  'target_hours.update': ['Sollzeiten geändert', 'Target hours changed'],
  'day.correct': ['Tag durch Admin korrigiert', 'Day corrected by admin'],
  'approval.submit': ['Monat eingereicht', 'Month submitted'],
  'approval.approve': ['Monat freigegeben', 'Month approved'],
  'approval.reject': ['Monat zurückgewiesen', 'Month rejected'],
  'approval.reopen': ['Freigabe zurückgesetzt', 'Approval reset'],
  'export.create': ['Export erstellt', 'Export created'],
  'leave.request': ['Urlaub/Abbau beantragt', 'Leave/time off requested'],
  'leave.approve': ['Antrag genehmigt', 'Request approved'],
  'leave.reject': ['Antrag abgelehnt', 'Request rejected'],
  'leave.cancel': ['Antrag storniert', 'Request cancelled'],
  'leave.settings': ['Urlaubseinstellungen geändert', 'Leave settings changed'],
  'leave.profile': ['Urlaubsanspruch geändert', 'Leave entitlement changed'],
  'leave.adjust': ['Urlaubskonto gebucht', 'Leave account booked'],
  'overtime.book': ['Überstunden gebucht', 'Overtime booked'],
  'payroll.config': ['Lohn-Einstellungen geändert', 'Payroll settings changed'],
  'payroll.member': ['Personalnummer geändert', 'Personnel number changed'],
  'payroll.export': ['Lohn-Export erstellt', 'Payroll export created'],
  'payroll.credentials': ['Personio-Zugang gespeichert', 'Personio credentials saved'],
  'payroll.credentials.delete': ['Personio-Zugang entfernt', 'Personio credentials removed'],
  'payroll.transfer': ['An Personio übertragen', 'Transferred to Personio'],
  'features.update': ['Funktionen geändert', 'Features changed'],
  'project.create': ['Projekt angelegt', 'Project created'],
  'project.update': ['Projekt geändert', 'Project changed'],
  'network.update': ['Firmen-Netz geändert', 'Company network changed'],
  'home_office.view': ['Homeoffice-Zahlen abgerufen', 'Home office figures viewed'],
});

export const LEAVE_KIND_LABELS = pick({
  vacation: ['Urlaub', 'Vacation'],
  overtime: ['Überstundenabbau', 'Overtime reduction'],
});
export const LEAVE_STATUS_LABELS = pick({
  pending: ['offen', 'pending'],
  approved: ['genehmigt', 'approved'],
  rejected: ['abgelehnt', 'rejected'],
  cancelled: ['storniert', 'cancelled'],
});
export const CALENDAR_KIND_LABELS = pick({
  vacation: ['Urlaub', 'Vacation'],
  overtime: ['Überstundenabbau', 'Overtime reduction'],
  absent: ['abwesend', 'absent'],
});
export const BOOKING_KIND_LABELS = pick({
  payout: ['Auszahlung', 'Payout'],
  cap: ['Kappung', 'Cap'],
  correction: ['Korrektur', 'Correction'],
});
export const PAYROLL_FORMAT_LABELS = pick({
  datev_lodas: ['DATEV LODAS (ASCII-Import)', 'DATEV LODAS (ASCII import)'],
  datev_lug: ['DATEV Lohn und Gehalt (ASCII-Import)', 'DATEV Lohn und Gehalt (ASCII import)'],
  lexware: ['Lexware lohn+gehalt (Import-ASCII)', 'Lexware lohn+gehalt (ASCII import)'],
});
export const TRANSFER_LABELS = pick({
  ok: ['erfolgreich', 'successful'],
  partial: ['teilweise erfolgreich', 'partially successful'],
  failed: ['fehlgeschlagen', 'failed'],
  transferred: ['übertragen', 'transferred'],
  skipped: ['übersprungen', 'skipped'],
});

export const RULE_LABELS: Record<string, string> = pick({
  shutdownBonusMin: ['Aufschlag beim Herunterfahren (Minuten)', 'Shutdown allowance (minutes)'],
  restartWindowMin: ['Neustart-Fenster (Minuten)', 'Restart window (minutes)'],
  updateRestartWindowMin: [
    'Neustart-Fenster bei Updates (Minuten)',
    'Restart window for updates (minutes)',
  ],
  netGraceMin: ['Karenzzeit bei Netz-Verlust (Minuten)', 'Grace period on network loss (minutes)'],
  standbyBreakMin: [
    'Inaktivität am Laptop ab … Minuten = Pause',
    'Laptop inactivity from … minutes = break',
  ],
  maxStandbyMin: [
    'Inaktivität ab … Minuten = Sitzungsende',
    'Inactivity from … minutes = end of session',
  ],
  maxBreakMin: ['Lücke ab … Minuten trennt Sitzungen', 'Gap from … minutes splits sessions'],
  maxSessionH: ['Höchstdauer einer Sitzung (Stunden)', 'Maximum session length (hours)'],
});

const ERRORS: Record<string, string> = pick({
  invalid_credentials: ['E-Mail oder Passwort ist falsch.', 'Email or password is incorrect.'],
  totp_required: [
    'Bitte den Code aus der Authenticator-App eingeben.',
    'Please enter the code from your authenticator app.',
  ],
  invalid_totp: ['Der Code ist falsch oder abgelaufen.', 'The code is wrong or has expired.'],
  email_not_verified: [
    'Bitte zuerst die E-Mail-Adresse bestätigen.',
    'Please confirm your email address first.',
  ],
  account_deactivated: ['Dieses Konto wurde deaktiviert.', 'This account has been deactivated.'],
  sso_required: [
    'Deine Organisation verlangt die Anmeldung über SSO.',
    'Your organisation requires sign-in via SSO.',
  ],
  rate_limited: [
    'Zu viele Versuche. Bitte kurz warten.',
    'Too many attempts. Please wait a moment.',
  ],
  invalid_token: ['Der Link ist ungültig oder abgelaufen.', 'The link is invalid or has expired.'],
  email_in_use: [
    'Für diese Adresse gibt es bereits ein Konto.',
    'An account already exists for this address.',
  ],
  last_admin: [
    'Die Organisation braucht mindestens einen Admin.',
    'The organisation needs at least one admin.',
  ],
  slug_taken: ['Dieser Kurzname ist schon vergeben.', 'This short name is already taken.'],
  not_submitted: [
    'Der Monat ist nicht (mehr) eingereicht.',
    'The month is not (or no longer) submitted.',
  ],
  self_approval: [
    'Den eigenen Monat kann man nicht selbst freigeben.',
    'You cannot approve your own month.',
  ],
  invalid_manager: [
    'Als Teamleitung kommen nur Manager oder Admins in Frage.',
    'Only managers or admins can lead a team.',
  ],
  issuer_must_be_https: [
    'Die Issuer-Adresse muss mit https:// beginnen.',
    'The issuer URL must start with https://.',
  ],
  not_a_member: [
    'Dieses Konto gehört nicht zu der Organisation.',
    'This account does not belong to the organisation.',
  ],
  subject_mismatch: [
    'Das IdP-Konto passt nicht zum hinterlegten Konto.',
    'The IdP account does not match the stored account.',
  ],
  domain_not_allowed: [
    'Die E-Mail-Domain ist für SSO nicht freigegeben.',
    'The email domain is not enabled for SSO.',
  ],
  email_missing: [
    'Der IdP hat keine bestätigte E-Mail-Adresse geliefert.',
    'The IdP did not provide a verified email address.',
  ],
  invalid_response: ['Die Antwort des IdP war ungültig.', 'The IdP response was invalid.'],
  idp_error: ['Der IdP hat die Anmeldung abgebrochen.', 'The IdP cancelled the sign-in.'],
  not_configured: [
    'SSO ist für diese Organisation nicht eingerichtet.',
    'SSO is not set up for this organisation.',
  ],
  forbidden: ['Dafür fehlt die Berechtigung.', 'You do not have permission for this.'],
  not_found: ['Nicht gefunden.', 'Not found.'],
  cannot_deactivate_self: [
    'Das eigene Konto lässt sich hier nicht deaktivieren.',
    'You cannot deactivate your own account here.',
  ],
  reason_required: ['Bitte eine Begründung angeben.', 'Please give a reason.'],
  overlapping_request: [
    'Für diesen Zeitraum gibt es schon einen Antrag oder eine Abwesenheit.',
    'There is already a request or absence for this period.',
  ],
  month_locked: [
    'Der Monat ist freigegeben. Nur ein Admin kann ihn dafür wieder öffnen.',
    'The month is approved. Only an admin can reopen it.',
  ],
  no_workdays: ['Im Zeitraum liegt kein Arbeitstag.', 'There is no working day in this period.'],
  already_started: ['Der Zeitraum hat schon begonnen.', 'The period has already started.'],
  not_pending: ['Der Antrag ist nicht mehr offen.', 'The request is no longer pending.'],
  not_cancellable: ['Der Antrag lässt sich nicht stornieren.', 'The request cannot be cancelled.'],
  use_own_cancel: [
    'Eigene Anträge bitte in der App stornieren.',
    'Please cancel your own requests in the app.',
  ],
  self_booking: [
    'Buchungen am eigenen Konto sind nicht erlaubt.',
    'Bookings on your own account are not allowed.',
  ],
  managed_by_admin: [
    'Das pflegt der Admin der Organisation.',
    'This is managed by the organisation admin.',
  ],
  nothing_to_export: [
    'Kein Mitglied mit freigegebenem Monat und Personalnummer.',
    'No member with an approved month and a personnel number.',
  ],
  payroll_config_incomplete: [
    'Lohn-Einstellungen unvollständig (Lohnart bzw. Berater-/Mandantennummer).',
    'Payroll settings incomplete (wage type or consultant/client number).',
  ],
  personio_not_configured: [
    'Bitte zuerst den Personio-Zugang hinterlegen.',
    'Please add the Personio credentials first.',
  ],
  feature_disabled: [
    'Diese Funktion ist in der Organisation ausgeschaltet.',
    'This feature is turned off for the organisation.',
  ],
  projects_disabled: ['Projekte sind ausgeschaltet.', 'Projects are turned off.'],
  calendar_disabled: [
    'Die Kalender-Anbindung ist ausgeschaltet.',
    'The calendar connection is turned off.',
  ],
  invalid_team: ['Dieses Team gibt es nicht.', 'This team does not exist.'],
  invalid_project: [
    'Dieses Projekt gibt es nicht oder es ist archiviert.',
    'This project does not exist or is archived.',
  ],
  provider_not_configured: [
    'Dieser Kalender-Anbieter ist auf dem Server nicht eingerichtet.',
    'This calendar provider is not set up on the server.',
  ],
  invalid_redirect: ['Ungültige Rücksprung-Adresse.', 'Invalid redirect address.'],
});

// Gründe aus der Personio-Übertragung kommen vom Server auf Deutsch (auch in der Historie).
const TRANSFER_MESSAGES: Record<string, string> = {
  'Monat nicht freigegeben': 'Month not approved',
  'Keine Personio-Person zur E-Mail': 'No Personio person for this email',
  'Keine Personio-ID hinterlegt': 'No Personio ID stored',
  'Personio nicht erreichbar': 'Personio cannot be reached',
};

/** Grund einer Personio-Übertragung in der aktuellen Sprache. */
export function transferMessage(message: string): string {
  return locale === 'en' ? (TRANSFER_MESSAGES[message] ?? message) : message;
}

export function errorText(err: unknown): string {
  const prefix = L('Fehler', 'Error');
  if (err instanceof ApiError) {
    return (
      ERRORS[err.code] ??
      `${prefix}: ${err.code}${err.message !== err.code ? ` (${err.message})` : ''}`
    );
  }
  if (typeof err === 'string') return ERRORS[err] ?? `${prefix}: ${err}`;
  return L('Der Server ist nicht erreichbar.', 'The server cannot be reached.');
}

const viewerTz = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Uhrzeit in der Zeitzone des Browsers. */
export function clock(iso: string | undefined): string {
  if (!iso) return '–';
  return new Intl.DateTimeFormat(intlLocale, {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: viewerTz,
  }).format(new Date(iso));
}

export function dateTime(iso: string): string {
  return new Intl.DateTimeFormat(intlLocale, {
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
