//! HTTP-Client gegen einen Mini-Server: Token-Erneuerung und Fehlerzuordnung.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use timelog_core::http::{DeviceInfo, HttpApi, LoginRequest, Tokens};
use timelog_core::{Api, ApiError};

type Log = Arc<Mutex<Vec<(String, String, String)>>>;

/// Beantwortet Anfragen nacheinander mit den vorgegebenen (Status, Körper).
fn server(responses: Vec<(u16, &'static str)>) -> (String, Log) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let log: Log = Arc::default();
    let seen = Arc::clone(&log);
    std::thread::spawn(move || {
        for (status, body) in responses {
            let Ok((mut stream, _)) = listener.accept() else { return };
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            let mut auth = String::new();
            let mut len = 0usize;
            loop {
                let mut h = String::new();
                reader.read_line(&mut h).unwrap();
                let h = h.trim_end();
                if h.is_empty() {
                    break;
                }
                let lower = h.to_lowercase();
                if let Some(v) = lower.strip_prefix("content-length: ") {
                    len = v.parse().unwrap();
                }
                if lower.starts_with("authorization: ") {
                    h["authorization: ".len()..].clone_into(&mut auth);
                }
            }
            let mut buf = vec![0; len];
            reader.read_exact(&mut buf).unwrap();
            let path = line.split_whitespace().take(2).collect::<Vec<_>>().join(" ");
            seen.lock().unwrap().push((path, auth, String::from_utf8(buf).unwrap()));
            let resp = format!(
                "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(resp.as_bytes()).unwrap();
        }
    });
    (format!("http://{addr}/"), log)
}

const TOKENS: &str = r#"{"accessToken":"neu","refreshToken":"r2","expiresIn":900,"deviceId":"d1","totpSetupRequired":false}"#;

fn tokens() -> Tokens {
    Tokens { access_token: "alt".into(), refresh_token: "r1".into(), device_id: "d1".into() }
}

#[test]
fn erneuert_das_token_bei_401_und_wiederholt() {
    let (url, log) = server(vec![
        (401, r#"{"error":"unauthorized"}"#),
        (200, TOKENS),
        (200, r#"{"accepted":0,"duplicates":0}"#),
    ]);
    let api = HttpApi::new(&url, tokens(), Duration::from_secs(5));
    api.put_presence(&[]).unwrap();
    let log = log.lock().unwrap();
    assert_eq!(log[0].0, "PUT /api/v1/presence");
    assert_eq!(log[0].1, "Bearer alt");
    assert_eq!(log[1].0, "POST /api/v1/auth/refresh");
    assert_eq!(log[1].2, r#"{"refreshToken":"r1"}"#);
    assert_eq!(log[2].1, "Bearer neu");
    assert_eq!(api.tokens().refresh_token, "r2");
}

#[test]
fn abgelaufene_familie_ergibt_unauthorized() {
    let (url, _) = server(vec![(401, "{}"), (401, r#"{"error":"invalid_token"}"#)]);
    let api = HttpApi::new(&url, tokens(), Duration::from_secs(5));
    assert_eq!(api.get_networks(), Err(ApiError::Unauthorized));
}

#[test]
fn fehler_werden_zugeordnet() {
    let (url, _) = server(vec![(400, r#"{"error":"invalid_request"}"#), (503, "")]);
    let api = HttpApi::new(&url, tokens(), Duration::from_secs(5));
    assert_eq!(api.post_events(&[]), Err(ApiError::Rejected { status: 400, code: "invalid_request".into() }));
    assert!(matches!(api.post_events(&[]), Err(ApiError::Unavailable(_))));
    let unreachable = HttpApi::new("http://127.0.0.1:9", tokens(), Duration::from_millis(500));
    assert!(matches!(unreachable.get_networks(), Err(ApiError::Unavailable(_))));
}

#[test]
fn anmeldung_liefert_tokens() {
    let (url, log) = server(vec![(200, TOKENS)]);
    let req = LoginRequest {
        email: "a@b.de".into(),
        password: "geheim".into(),
        totp: None,
        device_id: None,
        device: DeviceInfo { kind: "desktop", os: "test".into(), name: "Laptop".into() },
    };
    let (api, totp_required) = HttpApi::login(&url, &req, Duration::from_secs(5)).unwrap();
    assert!(!totp_required);
    assert_eq!(api.tokens().access_token, "neu");
    assert_eq!(api.base_url(), url.trim_end_matches('/'));
    let body: serde_json::Value = serde_json::from_str(&log.lock().unwrap()[0].2).unwrap();
    assert_eq!(body["device"]["kind"], "desktop");
    assert!(body.get("totp").is_none());
}
