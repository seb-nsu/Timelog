import {
  API_PREFIX,
  ORG_RULES_KEYS,
  type OrgConfigResponse,
  type OrgConfigUpdate,
  type OrgRulesConfig,
} from '@timelog/shared';
import { type SyntheticEvent, useState } from 'react';
import { RULE_LABELS, errorText } from '../texts.js';
import { ErrorText, Loading, useAdmin, useLoad } from '../ui.js';

/** Regelwerk-Parameter, Aufbewahrungsfrist und SSO der Organisation. */
export function Settings() {
  const { api } = useAdmin();
  const config = useLoad(() => api.org.config.get(), [api]);
  return (
    <section aria-labelledby="page-title" className="stack">
      <h1 id="page-title" tabIndex={-1}>
        Einstellungen
      </h1>
      <ErrorText text={config.error} />
      {!config.data && !config.error && <Loading what="Einstellungen" />}
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

  const ssoBase = `${new URL(API_PREFIX, baseUrl).toString()}/auth/sso/${slug || '<kurzname>'}`;

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
      notify('Einstellungen gespeichert.');
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
          Kurzname (für die SSO-Anmeldung)
          <input
            value={slug}
            pattern="[a-z0-9][a-z0-9\-]{1,38}[a-z0-9]"
            onChange={(e) => {
              setSlug(e.target.value);
            }}
          />
        </label>
        <label>
          Aufbewahrungsfrist in Jahren (mindestens 2 nach § 16 Abs. 2 ArbZG, bis 6 für
          Lohnunterlagen)
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
        <legend>Regelwerk-Parameter (leer = Standardwert)</legend>
        <p className="muted">
          Änderungen wirken auf alle noch nicht freigegebenen Monate; freigegebene Monate bleiben
          unverändert. Gesetzliche Schwellen (Pausen, 10 Stunden, Ruhezeit) sind nicht einstellbar.
          Version {config.rulesConfigVersion}.
        </p>
        {ORG_RULES_KEYS.map((k) => (
          <label key={k}>
            {RULE_LABELS[k] ?? k} – Standard {config.ruleDefaults[k] ?? '–'}
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
          Secrets werden hier nie eingetragen: Der Client-Secret steht als Umgebungsvariable auf dem
          Server (Präfix SSO_), hier nur ihr Name.
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
              Anbieter
              <select
                value={provider}
                onChange={(e) => {
                  setProvider(e.target.value as OidcProvider);
                }}
              >
                <option value="entra">Microsoft Entra ID</option>
                <option value="google">Google</option>
                <option value="oidc">Anderer OIDC-Anbieter</option>
              </select>
            </label>
            <label>
              Issuer
              <input
                type="url"
                placeholder={
                  provider === 'entra'
                    ? 'https://login.microsoftonline.com/<Mandanten-ID>/v2.0'
                    : 'https://accounts.google.com'
                }
                value={issuer}
                onChange={(e) => {
                  setIssuer(e.target.value);
                }}
              />
            </label>
            <label>
              Client-ID (Anwendungs-ID)
              <input
                required
                value={clientId}
                onChange={(e) => {
                  setClientId(e.target.value);
                }}
              />
            </label>
            <label>
              Name der Umgebungsvariable mit dem Client-Secret
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
              Umleitungs-URI beim IdP eintragen:{' '}
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
              Anmelde-URL des IdP (SSO-URL)
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
              Signaturzertifikat des IdP (PEM oder Base64)
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
              Entity-ID des IdP (optional)
              <input
                value={idpIssuer}
                onChange={(e) => {
                  setIdpIssuer(e.target.value);
                }}
              />
            </label>
            <label>
              Attribut mit der E-Mail-Adresse (optional)
              <input
                value={emailAttribute}
                onChange={(e) => {
                  setEmailAttribute(e.target.value);
                }}
              />
            </label>
            <p className="muted">
              Entity-ID und Metadaten: <code className="wrap">{ssoBase}/saml/metadata</code>,
              Antwort-URL (ACS): <code className="wrap">{ssoBase}/saml/acs</code>
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
          Anmeldung nur über SSO (Admins behalten Passwort und Zwei-Faktor als Notzugang)
        </label>
        <label className="inline">
          <input
            type="checkbox"
            checked={autoProvision}
            onChange={(e) => {
              setAutoProvision(e.target.checked);
            }}
          />
          Unbekannte Personen aus erlaubten Domains bei der ersten Anmeldung als Mitglied anlegen
        </label>
        <label>
          Erlaubte E-Mail-Domains (kommagetrennt, leer = alle)
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
        Speichern
      </button>
    </form>
  );
}
