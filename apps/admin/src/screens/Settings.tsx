import {
  API_PREFIX,
  ORG_RULES_KEYS,
  type OrgConfigResponse,
  type OrgConfigUpdate,
  type OrgRulesConfig,
} from '@timelog/shared';
import { type SyntheticEvent, useState } from 'react';
import { L, RULE_LABELS, errorText } from '../texts.js';
import { ErrorText, Loading, useAdmin, useLoad } from '../ui.js';
import { Features } from './Features.js';

/** Regelwerk-Parameter, Aufbewahrungsfrist und SSO der Organisation. */
export function Settings() {
  const { api } = useAdmin();
  const config = useLoad(() => api.org.config.get(), [api]);
  return (
    <section aria-labelledby="page-title" className="stack">
      <h1 id="page-title" tabIndex={-1}>
        {L('Einstellungen', 'Settings')}
      </h1>
      <Features />
      <ErrorText text={config.error} />
      {!config.data && !config.error && <Loading what={L('Einstellungen', 'settings')} />}
      {config.data && <SettingsForm config={config.data} onSaved={config.reload} />}
    </section>
  );
}

type OidcProvider = 'entra' | 'google' | 'oidc';

function SettingsForm({ config, onSaved }: { config: OrgConfigResponse; onSaved: () => void }) {
  const { api, notify, baseUrl } = useAdmin();
  const [name, setName] = useState(config.name);
  const [slug, setSlug] = useState(config.slug ?? '');
  const [retention, setRetention] = useState(config.retentionYears);
  const [rules, setRules] = useState<Record<string, string>>(() =>
    Object.fromEntries(ORG_RULES_KEYS.map((k) => [k, config.rules[k]?.toString() ?? ''])),
  );
  const sso = config.sso;
  const [oidcOn, setOidcOn] = useState(sso.oidc !== undefined);
  const [provider, setProvider] = useState<OidcProvider>(sso.oidc?.provider ?? 'entra');
  const [issuer, setIssuer] = useState(sso.oidc?.issuer ?? '');
  const [clientId, setClientId] = useState(sso.oidc?.clientId ?? '');
  const [secretEnv, setSecretEnv] = useState(sso.oidc?.clientSecretEnv ?? '');
  const [samlOn, setSamlOn] = useState(sso.saml !== undefined);
  const [entryPoint, setEntryPoint] = useState(sso.saml?.entryPoint ?? '');
  const [idpCert, setIdpCert] = useState(sso.saml?.idpCert ?? '');
  const [idpIssuer, setIdpIssuer] = useState(sso.saml?.idpIssuer ?? '');
  const [emailAttribute, setEmailAttribute] = useState(sso.saml?.emailAttribute ?? '');
  const [enforced, setEnforced] = useState(sso.enforced);
  const [autoProvision, setAutoProvision] = useState(sso.autoProvision);
  const [domains, setDomains] = useState(sso.allowedDomains.join(', '));
  const [error, setError] = useState<string>();

  const ssoBase = `${new URL(API_PREFIX, baseUrl).toString()}/auth/sso/${slug || L('<kurzname>', '<short-name>')}`;

  const save = async (e: SyntheticEvent) => {
    e.preventDefault();
    setError(undefined);
    const parsedRules: OrgRulesConfig = {};
    for (const k of ORG_RULES_KEYS) {
      const v = rules[k]?.trim();
      if (v) parsedRules[k] = Number(v);
    }
    const body: OrgConfigUpdate = {
      name: name.trim(),
      ...(slug.trim() ? { slug: slug.trim() } : {}),
      retentionYears: retention,
      rules: parsedRules,
      sso: {
        ...(oidcOn
          ? {
              oidc: {
                provider,
                issuer:
                  issuer.trim() || (provider === 'google' ? 'https://accounts.google.com' : ''),
                clientId: clientId.trim(),
                clientSecretEnv: secretEnv.trim(),
              },
            }
          : {}),
        ...(samlOn
          ? {
              saml: {
                entryPoint: entryPoint.trim(),
                idpCert: idpCert.trim(),
                ...(idpIssuer.trim() ? { idpIssuer: idpIssuer.trim() } : {}),
                ...(emailAttribute.trim() ? { emailAttribute: emailAttribute.trim() } : {}),
              },
            }
          : {}),
        enforced,
        autoProvision,
        allowedDomains: domains
          .split(',')
          .map((d) => d.trim().toLowerCase())
          .filter((d) => d.length > 0),
      },
    };
    try {
      await api.org.config.put(body);
      notify(L('Einstellungen gespeichert.', 'Settings saved.'));
      onSaved();
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <form onSubmit={(e) => void save(e)} className="stack">
      <fieldset>
        <legend>Organisation</legend>
        <label>
          Name
          <input
            required
            value={name}
            onChange={(e) => {
              setName(e.target.value);
            }}
          />
        </label>
        <label>
          {L('Kurzname (für die SSO-Anmeldung)', 'Short name (for SSO sign-in)')}
          <input
            value={slug}
            pattern="[a-z0-9][a-z0-9\-]{1,38}[a-z0-9]"
            onChange={(e) => {
              setSlug(e.target.value);
            }}
          />
        </label>
        <label>
          {L(
            'Aufbewahrungsfrist in Jahren (mindestens 2 nach § 16 Abs. 2 ArbZG, bis 6 für Lohnunterlagen)',
            'Retention period in years (at least 2 under § 16(2) ArbZG, up to 6 for payroll records)',
          )}
          <input
            type="number"
            min={2}
            max={6}
            required
            value={retention}
            onChange={(e) => {
              setRetention(Number(e.target.value));
            }}
          />
        </label>
      </fieldset>

      <fieldset>
        <legend>
          {L('Regelwerk-Parameter (leer = Standardwert)', 'Rule parameters (empty = default)')}
        </legend>
        <p className="muted">
          {L(
            'Änderungen wirken auf alle noch nicht freigegebenen Monate; freigegebene Monate bleiben unverändert. Gesetzliche Schwellen (Pausen, 10 Stunden, Ruhezeit) sind nicht einstellbar.',
            'Changes apply to all months not yet approved; approved months stay unchanged. Statutory thresholds (breaks, 10 hours, rest period) cannot be changed.',
          )}{' '}
          Version {config.rulesConfigVersion}.
        </p>
        {ORG_RULES_KEYS.map((k) => (
          <label key={k}>
            {RULE_LABELS[k] ?? k} – {L('Standard', 'default')} {config.ruleDefaults[k] ?? '–'}
            <input
              type="number"
              min={0}
              inputMode="numeric"
              placeholder={String(config.ruleDefaults[k] ?? '')}
              value={rules[k] ?? ''}
              onChange={(e) => {
                setRules({ ...rules, [k]: e.target.value });
              }}
            />
          </label>
        ))}
      </fieldset>

      <fieldset>
        <legend>Single Sign-on</legend>
        <p className="muted">
          {L(
            'Secrets werden hier nie eingetragen: Der Client-Secret steht als Umgebungsvariable auf dem Server (Präfix SSO_), hier nur ihr Name.',
            'Secrets are never entered here: the client secret is an environment variable on the server (prefix SSO_); only its name goes here.',
          )}
        </p>
        <label className="inline">
          <input
            type="checkbox"
            checked={oidcOn}
            onChange={(e) => {
              setOidcOn(e.target.checked);
            }}
          />
          OpenID Connect (Microsoft Entra ID, Google)
        </label>
        {oidcOn && (
          <div className="stack indent">
            <label>
              {L('Anbieter', 'Provider')}
              <select
                value={provider}
                onChange={(e) => {
                  setProvider(e.target.value as OidcProvider);
                }}
              >
                <option value="entra">Microsoft Entra ID</option>
                <option value="google">Google</option>
                <option value="oidc">{L('Anderer OIDC-Anbieter', 'Other OIDC provider')}</option>
              </select>
            </label>
            <label>
              Issuer
              <input
                type="url"
                placeholder={
                  provider === 'entra'
                    ? L(
                        'https://login.microsoftonline.com/<Mandanten-ID>/v2.0',
                        'https://login.microsoftonline.com/<tenant-ID>/v2.0',
                      )
                    : 'https://accounts.google.com'
                }
                value={issuer}
                onChange={(e) => {
                  setIssuer(e.target.value);
                }}
              />
            </label>
            <label>
              {L('Client-ID (Anwendungs-ID)', 'Client ID (application ID)')}
              <input
                required
                value={clientId}
                onChange={(e) => {
                  setClientId(e.target.value);
                }}
              />
            </label>
            <label>
              {L(
                'Name der Umgebungsvariable mit dem Client-Secret',
                'Name of the environment variable holding the client secret',
              )}
              <input
                required
                pattern="SSO_[A-Z0-9_]{1,64}"
                placeholder="SSO_FIRMA_SECRET"
                value={secretEnv}
                onChange={(e) => {
                  setSecretEnv(e.target.value);
                }}
              />
            </label>
            <p className="muted">
              {L('Umleitungs-URI beim IdP eintragen:', 'Redirect URI to enter at the IdP:')}{' '}
              <code className="wrap">{ssoBase}/oidc/callback</code>
            </p>
          </div>
        )}
        <label className="inline">
          <input
            type="checkbox"
            checked={samlOn}
            onChange={(e) => {
              setSamlOn(e.target.checked);
            }}
          />
          SAML 2.0
        </label>
        {samlOn && (
          <div className="stack indent">
            <label>
              {L('Anmelde-URL des IdP (SSO-URL)', 'IdP sign-in URL (SSO URL)')}
              <input
                type="url"
                required
                value={entryPoint}
                onChange={(e) => {
                  setEntryPoint(e.target.value);
                }}
              />
            </label>
            <label>
              {L(
                'Signaturzertifikat des IdP (PEM oder Base64)',
                'IdP signing certificate (PEM or Base64)',
              )}
              <textarea
                rows={5}
                required
                value={idpCert}
                onChange={(e) => {
                  setIdpCert(e.target.value);
                }}
              />
            </label>
            <label>
              {L('Entity-ID des IdP (optional)', 'IdP entity ID (optional)')}
              <input
                value={idpIssuer}
                onChange={(e) => {
                  setIdpIssuer(e.target.value);
                }}
              />
            </label>
            <label>
              {L(
                'Attribut mit der E-Mail-Adresse (optional)',
                'Attribute containing the email address (optional)',
              )}
              <input
                value={emailAttribute}
                onChange={(e) => {
                  setEmailAttribute(e.target.value);
                }}
              />
            </label>
            <p className="muted">
              {L('Entity-ID und Metadaten:', 'Entity ID and metadata:')}{' '}
              <code className="wrap">{ssoBase}/saml/metadata</code>,
              {L('Antwort-URL (ACS):', 'Reply URL (ACS):')}{' '}
              <code className="wrap">{ssoBase}/saml/acs</code>
            </p>
          </div>
        )}
        <label className="inline">
          <input
            type="checkbox"
            checked={enforced}
            onChange={(e) => {
              setEnforced(e.target.checked);
            }}
          />
          {L(
            'Anmeldung nur über SSO (Admins behalten Passwort und Zwei-Faktor als Notzugang)',
            'Sign-in via SSO only (admins keep password and two-factor as emergency access)',
          )}
        </label>
        <label className="inline">
          <input
            type="checkbox"
            checked={autoProvision}
            onChange={(e) => {
              setAutoProvision(e.target.checked);
            }}
          />
          {L(
            'Unbekannte Personen aus erlaubten Domains bei der ersten Anmeldung als Mitglied anlegen',
            'Create unknown people from allowed domains as members on first sign-in',
          )}
        </label>
        <label>
          {L(
            'Erlaubte E-Mail-Domains (kommagetrennt, leer = alle)',
            'Allowed email domains (comma-separated, empty = all)',
          )}
          <input
            value={domains}
            onChange={(e) => {
              setDomains(e.target.value);
            }}
          />
        </label>
      </fieldset>
      <ErrorText text={error} />
      <button type="submit" className="primary">
        {L('Speichern', 'Save')}
      </button>
    </form>
  );
}
