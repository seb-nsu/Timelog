//! HTTP-Anbindung an das Backend (`/api/v1`). Hält die Tokens; die Oberfläche sieht sie nie.

use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::model::{Event, NetworkConfig, Span};
use crate::sync::{Api, ApiError};

pub const API_PREFIX: &str = "/api/v1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tokens {
    pub access_token: String,
    pub refresh_token: String,
    pub device_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TokenResponse {
    access_token: String,
    refresh_token: String,
    device_id: String,
    totp_setup_required: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct DeviceInfo {
    pub kind: &'static str,
    pub os: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginRequest {
    pub email: String,
    pub password: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub totp: Option<String>,
    /// Bei erneuter Anmeldung desselben Geräts.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
    pub device: DeviceInfo,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpResponse {
    pub status: u16,
    pub body: String,
}

#[derive(Debug, Deserialize)]
struct ErrorBody {
    error: String,
}

#[derive(Clone)]
pub struct HttpApi {
    agent: ureq::Agent,
    base_url: String,
    tokens: Arc<Mutex<Tokens>>,
}

fn agent(timeout: Duration) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(timeout))
        .http_status_as_error(false)
        .build()
        .into()
}

fn send(
    agent: &ureq::Agent,
    method: &str,
    url: &str,
    bearer: Option<&str>,
    body: Option<&str>,
) -> Result<HttpResponse, ApiError> {
    let unavailable = |e: ureq::Error| ApiError::Unavailable(e.to_string());
    let auth = bearer.map(|t| format!("Bearer {t}"));
    let result = match method {
        "GET" | "DELETE" if body.is_none() => {
            let mut req = if method == "GET" {
                agent.get(url)
            } else {
                agent.delete(url)
            };
            if let Some(a) = &auth {
                req = req.header("authorization", a);
            }
            req.call()
        }
        _ => {
            let mut req = match method {
                "POST" => agent.post(url),
                "PUT" => agent.put(url),
                "PATCH" => agent.patch(url),
                "DELETE" => agent.delete(url).force_send_body(),
                other => {
                    return Err(ApiError::Rejected {
                        status: 405,
                        code: format!("method_{other}"),
                    })
                }
            };
            if let Some(a) = &auth {
                req = req.header("authorization", a);
            }
            req.header("content-type", "application/json")
                .send(body.unwrap_or("{}"))
        }
    };
    let mut resp = result.map_err(unavailable)?;
    let status = resp.status().as_u16();
    let body = resp.body_mut().read_to_string().map_err(unavailable)?;
    Ok(HttpResponse { status, body })
}

fn map_status(resp: &HttpResponse) -> Result<(), ApiError> {
    match resp.status {
        200..=299 => Ok(()),
        401 => Err(ApiError::Unauthorized),
        s if s >= 500 || s == 429 || s == 408 => Err(ApiError::Unavailable(format!("HTTP {s}"))),
        s => Err(ApiError::Rejected {
            status: s,
            code: serde_json::from_str::<ErrorBody>(&resp.body)
                .map_or_else(|_| "http_error".into(), |b| b.error),
        }),
    }
}

/// Normalisiert die Server-Adresse (ohne abschließenden Schrägstrich).
pub fn normalize_base_url(url: &str) -> String {
    url.trim().trim_end_matches('/').to_owned()
}

impl HttpApi {
    pub fn new(base_url: &str, tokens: Tokens, timeout: Duration) -> Self {
        Self {
            agent: agent(timeout),
            base_url: normalize_base_url(base_url),
            tokens: Arc::new(Mutex::new(tokens)),
        }
    }

    /// Meldet das Gerät an. Liefert die API und ob TOTP noch eingerichtet werden muss.
    pub fn login(
        base_url: &str,
        request: &LoginRequest,
        timeout: Duration,
    ) -> Result<(Self, bool), ApiError> {
        let base_url = normalize_base_url(base_url);
        let agent = agent(timeout);
        let body =
            serde_json::to_string(request).map_err(|e| ApiError::Unavailable(e.to_string()))?;
        let resp = send(
            &agent,
            "POST",
            &format!("{base_url}{API_PREFIX}/auth/login"),
            None,
            Some(&body),
        )?;
        // Bei der Anmeldung zählt der genaue Grund (z. B. `totp_required`), nicht nur „401“.
        if resp.status == 401 || resp.status == 403 {
            let code = serde_json::from_str::<ErrorBody>(&resp.body)
                .map_or_else(|_| "invalid_credentials".into(), |b| b.error);
            return Err(ApiError::Rejected {
                status: resp.status,
                code,
            });
        }
        map_status(&resp)?;
        let t: TokenResponse = serde_json::from_str(&resp.body)
            .map_err(|e| ApiError::Unavailable(format!("Antwort: {e}")))?;
        let tokens = Tokens {
            access_token: t.access_token,
            refresh_token: t.refresh_token,
            device_id: t.device_id,
        };
        Ok((
            Self {
                agent,
                base_url,
                tokens: Arc::new(Mutex::new(tokens)),
            },
            t.totp_setup_required,
        ))
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    /// Kopie mit eigener Zeitgrenze (z. B. 2 s beim Herunterfahren); Tokens werden geteilt.
    #[must_use]
    pub fn with_timeout(&self, timeout: Duration) -> Self {
        Self {
            agent: agent(timeout),
            base_url: self.base_url.clone(),
            tokens: Arc::clone(&self.tokens),
        }
    }

    pub fn tokens(&self) -> Tokens {
        self.tokens
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    fn refresh(&self) -> Result<(), ApiError> {
        let current = self.tokens();
        let body = json!({ "refreshToken": current.refresh_token }).to_string();
        let resp = send(
            &self.agent,
            "POST",
            &self.url("/auth/refresh"),
            None,
            Some(&body),
        )?;
        map_status(&resp)?;
        let t: TokenResponse = serde_json::from_str(&resp.body)
            .map_err(|e| ApiError::Unavailable(format!("Antwort: {e}")))?;
        *self.tokens.lock().unwrap_or_else(PoisonError::into_inner) = Tokens {
            access_token: t.access_token,
            refresh_token: t.refresh_token,
            device_id: t.device_id,
        };
        Ok(())
    }

    fn url(&self, path: &str) -> String {
        format!("{}{API_PREFIX}{path}", self.base_url)
    }

    /// Anfrage mit Access-Token; bei 401 einmal erneuern und wiederholen.
    /// Liefert jede HTTP-Antwort; `Err` nur bei Verbindungsproblemen.
    pub fn request(
        &self,
        method: &str,
        path: &str,
        body: Option<&str>,
    ) -> Result<HttpResponse, ApiError> {
        let resp = send(
            &self.agent,
            method,
            &self.url(path),
            Some(&self.tokens().access_token),
            body,
        )?;
        if resp.status != 401 {
            return Ok(resp);
        }
        match self.refresh() {
            Ok(()) => send(
                &self.agent,
                method,
                &self.url(path),
                Some(&self.tokens().access_token),
                body,
            ),
            Err(ApiError::Unauthorized | ApiError::Rejected { .. }) => Ok(resp),
            Err(e) => Err(e),
        }
    }

    fn json_request(
        &self,
        method: &str,
        path: &str,
        body: &serde_json::Value,
    ) -> Result<HttpResponse, ApiError> {
        let resp = self.request(method, path, Some(&body.to_string()))?;
        map_status(&resp)?;
        Ok(resp)
    }

    pub fn logout(&self) -> Result<(), ApiError> {
        let body = json!({ "refreshToken": self.tokens().refresh_token }).to_string();
        let resp = send(
            &self.agent,
            "POST",
            &self.url("/auth/logout"),
            None,
            Some(&body),
        )?;
        map_status(&resp)
    }
}

impl Api for HttpApi {
    fn post_events(&self, events: &[Event]) -> Result<(), ApiError> {
        self.json_request("POST", "/events/batch", &json!({ "events": events }))
            .map(drop)
    }

    fn put_presence(&self, spans: &[Span]) -> Result<(), ApiError> {
        self.json_request("PUT", "/presence", &json!({ "spans": spans }))
            .map(drop)
    }

    fn get_networks(&self) -> Result<NetworkConfig, ApiError> {
        let resp = self.request("GET", "/networks", None)?;
        map_status(&resp)?;
        serde_json::from_str(&resp.body).map_err(|e| ApiError::Unavailable(format!("Antwort: {e}")))
    }
}
