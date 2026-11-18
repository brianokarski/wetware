//! The only code in the app that talks to the network.
//!
//! Two things can be fetched, and the webview chooses neither host nor path:
//! intervals.icu wellness records or activities for a range of days, and
//! Open-Meteo daily weather for a place and a range of days. Each URL is
//! built here from arguments that are checked first.
//!
//! The intervals.icu API key is read from the Keychain here and goes into one
//! request header. It is never returned, logged, or put in an error. Errors
//! are one of a few fixed kinds; none carries a response body or a header.

use std::time::Duration;

use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{keychain, trace};

const INTERVALS_BASE: &str = "https://intervals.icu";
const OPEN_METEO_BASE: &str = "https://api.open-meteo.com";

/// The daily series asked of Open-Meteo, always in °C and millimetres. The
/// units a day file is written in are worked out in `src/sync/`.
const WEATHER_DAILY: &str = "temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code";

/// What the app reads of an activity. The rest (names, routes, heart rate,
/// power) is dropped before the list is handed to the webview.
const ACTIVITY_FIELDS: [&str; 7] =
    ["id", "start_date_local", "type", "source", "_note", "moving_time", "elapsed_time"];

const TIMEOUT: Duration = Duration::from_secs(30);
const MAX_BODY_BYTES: u64 = 16 * 1024 * 1024;
/// After a 429, try again this many times at most.
const MAX_RETRIES: usize = 3;
/// The longest single wait a `Retry-After` is honoured for. Asked to wait
/// longer, the fetch gives up and says so instead.
const MAX_WAIT: Duration = Duration::from_secs(30);
/// The wait before the first retry when the server names none. It doubles each time.
const FIRST_WAIT: Duration = Duration::from_secs(2);

/// Why a fetch failed, for the UI to put into words. Serialised as
/// `{ "kind": "rate_limited", "retry_after_secs": 30 }` and so on.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SyncError {
    /// No intervals.icu key in the Keychain.
    NoKey,
    /// intervals.icu answered 401 or 403.
    KeyRejected,
    /// Still 429 after backing off. `retry_after_secs` is what the server last asked for, if it said.
    RateLimited { retry_after_secs: Option<u64> },
    /// No answer: no network, no such host, connection refused or dropped, timed out.
    Offline,
    /// Anything else. `detail` is a status code or a few fixed words, never part of a response.
    Unexpected { detail: String },
}

fn unexpected(detail: impl Into<String>) -> SyncError {
    SyncError::Unexpected { detail: detail.into() }
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IntervalsKind {
    Wellness,
    Activities,
}

/// `YYYY-MM-DD` and nothing else, so it can go into a URL as it is.
fn day(text: &str) -> Result<&str, SyncError> {
    let bytes = text.as_bytes();
    let shaped = bytes.len() == 10
        && bytes.iter().enumerate().all(|(i, b)| if i == 4 || i == 7 { *b == b'-' } else { b.is_ascii_digit() });
    let number = |range: std::ops::Range<usize>| text[range].parse::<u32>().unwrap_or(0);
    if shaped && (1..=12).contains(&number(5..7)) && (1..=31).contains(&number(8..10)) {
        Ok(text)
    } else {
        Err(unexpected("a day to fetch was not a date"))
    }
}

/// Both ends of a range, in order, and no more than a year or so apart.
fn days<'a>(oldest: &'a str, newest: &'a str) -> Result<(&'a str, &'a str), SyncError> {
    let (oldest, newest) = (day(oldest)?, day(newest)?);
    let year = |text: &str| text[..4].parse::<i32>().unwrap_or(0);
    if oldest > newest || year(newest) - year(oldest) > 1 {
        return Err(unexpected("the days to fetch were not a range"));
    }
    Ok((oldest, newest))
}

/// intervals.icu, athlete `0`: the athlete the key belongs to.
fn intervals_url(base: &str, kind: IntervalsKind, oldest: &str, newest: &str) -> Result<String, SyncError> {
    let (oldest, newest) = days(oldest, newest)?;
    Ok(match kind {
        IntervalsKind::Wellness => {
            format!("{base}/api/v1/athlete/0/wellness?oldest={oldest}&newest={newest}")
        }
        // Activities are asked for by local date and time, so that everything on the last day is included.
        IntervalsKind::Activities => {
            format!("{base}/api/v1/athlete/0/activities?oldest={oldest}T00:00:00&newest={newest}T23:59:59")
        }
    })
}

fn weather_url(base: &str, latitude: f64, longitude: f64, oldest: &str, newest: &str) -> Result<String, SyncError> {
    let (oldest, newest) = days(oldest, newest)?;
    let on_earth = latitude.is_finite() && longitude.is_finite() && latitude.abs() <= 90.0 && longitude.abs() <= 180.0;
    if !on_earth {
        return Err(unexpected("the place to fetch weather for was not a latitude and longitude"));
    }
    Ok(format!(
        "{base}/v1/forecast?latitude={latitude}&longitude={longitude}&daily={WEATHER_DAILY}\
         &temperature_unit=celsius&precipitation_unit=mm&timezone=auto&start_date={oldest}&end_date={newest}"
    ))
}

/// HTTP Basic, user `API_KEY`, password the key (SPEC §7.1).
fn basic_auth(key: &str) -> String {
    format!("Basic {}", STANDARD.encode(format!("API_KEY:{key}")))
}

/// Redirects are never followed, so the key can't be sent on to another host.
fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(TIMEOUT))
        .max_redirects(0)
        .http_status_as_error(false)
        .user_agent(concat!("Wetware/", env!("CARGO_PKG_VERSION")))
        .build()
        .into()
}

/// The `Retry-After` header, when it is a number of seconds.
fn retry_after(response: &ureq::http::Response<ureq::Body>) -> Option<u64> {
    response.headers().get("retry-after")?.to_str().ok()?.trim().parse().ok()
}

/// What a failure to get any response at all comes down to.
fn transport(error: ureq::Error) -> SyncError {
    use ureq::Error::*;
    match error {
        BadUri(_) | Http(_) | Protocol(_) | LargeResponseHeader(..) | RequireHttpsOnly(_) => {
            unexpected("the request could not be made")
        }
        // The rest is the network: no route, no such host, refused, reset, timed out, no secure connection.
        _ => SyncError::Offline,
    }
}

/// GET `url` and parse the body as JSON. A 429 is retried after a wait, a
/// bounded number of times; `pause` does the waiting. A 401 or 403 means the
/// key was turned down, if one was sent.
fn get_json(
    url: &str,
    authorization: Option<&str>,
    pause: &mut dyn FnMut(Duration),
) -> Result<Value, SyncError> {
    let agent = agent();
    let mut wait = FIRST_WAIT;
    let mut retries = 0;
    loop {
        let mut request = agent.get(url).header("Accept", "application/json");
        if let Some(value) = authorization {
            request = request.header("Authorization", value);
        }
        let mut response = request.call().map_err(transport)?;
        let status = response.status().as_u16();
        match status {
            200..=299 => {
                let body = response
                    .body_mut()
                    .with_config()
                    .limit(MAX_BODY_BYTES)
                    .read_to_string()
                    .map_err(|_| unexpected("the response could not be read"))?;
                return serde_json::from_str(&body).map_err(|_| unexpected("the response was not JSON"));
            }
            429 => {
                let asked = retry_after(&response);
                let this_wait = asked.map_or(wait, Duration::from_secs);
                if retries == MAX_RETRIES || this_wait > MAX_WAIT {
                    return Err(SyncError::RateLimited { retry_after_secs: asked });
                }
                pause(this_wait);
                retries += 1;
                wait *= 2;
            }
            401 | 403 if authorization.is_some() => return Err(SyncError::KeyRejected),
            _ => return Err(unexpected(format!("HTTP {status}"))),
        }
    }
}

/// An activity cut down to the fields the app reads.
fn pruned(activity: Value) -> Value {
    match activity {
        Value::Object(fields) => Value::Object(
            fields.into_iter().filter(|(name, _)| ACTIVITY_FIELDS.contains(&name.as_str())).collect(),
        ),
        other => other,
    }
}

fn fetch_intervals(
    base: &str,
    key: Option<&str>,
    kind: IntervalsKind,
    oldest: &str,
    newest: &str,
    pause: &mut dyn FnMut(Duration),
) -> Result<Value, SyncError> {
    let url = intervals_url(base, kind, oldest, newest)?;
    let key = key.ok_or(SyncError::NoKey)?;
    match get_json(&url, Some(&basic_auth(key)), pause)? {
        Value::Array(items) if kind == IntervalsKind::Activities => {
            Ok(Value::Array(items.into_iter().map(pruned).collect()))
        }
        list @ Value::Array(_) => Ok(list),
        _ => Err(unexpected("the response was not a list")),
    }
}

fn fetch_weather(
    base: &str,
    latitude: f64,
    longitude: f64,
    oldest: &str,
    newest: &str,
    pause: &mut dyn FnMut(Duration),
) -> Result<Value, SyncError> {
    let url = weather_url(base, latitude, longitude, oldest, newest)?;
    match get_json(&url, None, pause)? {
        days @ Value::Object(_) => Ok(days),
        _ => Err(unexpected("the response was not a set of daily values")),
    }
}

/// Runs a fetch off the main thread: it blocks while it waits for the network.
async fn blocking<T: Send + 'static>(
    task: impl FnOnce() -> Result<T, SyncError> + Send + 'static,
) -> Result<T, SyncError> {
    tauri::async_runtime::spawn_blocking(task).await.unwrap_or_else(|_| Err(unexpected("the fetch stopped unexpectedly")))
}

/// intervals.icu wellness records or activities from `oldest` to `newest`
/// (both `YYYY-MM-DD`). The key comes from the Keychain and stays on this side.
#[tauri::command]
pub async fn intervals_fetch(kind: IntervalsKind, oldest: String, newest: String) -> Result<Value, SyncError> {
    trace("intervals_fetch");
    blocking(move || {
        let key = keychain::intervals_key().map_err(|_| unexpected("the Keychain could not be read"))?;
        fetch_intervals(INTERVALS_BASE, key.as_deref(), kind, &oldest, &newest, &mut std::thread::sleep)
    })
    .await
}

/// Open-Meteo daily weather at a latitude and longitude from `oldest` to `newest`.
#[tauri::command]
pub async fn weather_fetch(latitude: f64, longitude: f64, oldest: String, newest: String) -> Result<Value, SyncError> {
    trace("weather_fetch");
    blocking(move || fetch_weather(OPEN_METEO_BASE, latitude, longitude, &oldest, &newest, &mut std::thread::sleep)).await
}

#[cfg(test)]
mod tests {
    use std::{
        io::{BufRead, BufReader, Write},
        net::TcpListener,
        sync::{Arc, Mutex},
        thread::JoinHandle,
    };

    use serde_json::json;

    use super::*;

    const KEY: &str = "test-key-3f9a";
    const OCT_25: &str = "2026-10-25";
    const NOV_17: &str = "2026-11-17";

    /// A canned HTTP response: status, extra header lines, body.
    type Canned = (u16, &'static str, &'static str);

    /// A server on this machine that answers one request per canned response,
    /// in order, and keeps the head of every request it was sent.
    struct Server {
        base: String,
        requests: Arc<Mutex<Vec<String>>>,
        thread: Option<JoinHandle<()>>,
    }

    impl Server {
        fn answering(responses: Vec<Canned>) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let base = format!("http://{}", listener.local_addr().unwrap());
            let requests = Arc::new(Mutex::new(Vec::new()));
            let seen = requests.clone();
            let thread = std::thread::spawn(move || {
                for (status, headers, body) in responses {
                    let (mut stream, _) = listener.accept().unwrap();
                    let mut head = String::new();
                    let mut reader = BufReader::new(stream.try_clone().unwrap());
                    loop {
                        let mut line = String::new();
                        if reader.read_line(&mut line).unwrap() == 0 || line == "\r\n" {
                            break;
                        }
                        head.push_str(&line);
                    }
                    seen.lock().unwrap().push(head);
                    let response = format!(
                        "HTTP/1.1 {status} Canned\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{headers}\r\n{body}",
                        body.len()
                    );
                    stream.write_all(response.as_bytes()).unwrap();
                }
            });
            Server { base, requests, thread: Some(thread) }
        }

        /// Waits for every canned response to have been sent, then gives the request heads.
        fn requests(mut self) -> Vec<String> {
            self.thread.take().unwrap().join().unwrap();
            self.requests.lock().unwrap().clone()
        }
    }

    /// A base URL nothing is listening on.
    fn dead_base() -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        format!("http://{}", listener.local_addr().unwrap())
    }

    /// Runs `fetch` with a `pause` that records the waits instead of sleeping.
    fn waits<T>(fetch: impl FnOnce(&mut dyn FnMut(Duration)) -> T) -> (T, Vec<u64>) {
        let mut waited = Vec::new();
        let result = fetch(&mut |wait| waited.push(wait.as_secs()));
        (result, waited)
    }

    fn wellness(server: &Server) -> (Result<Value, SyncError>, Vec<u64>) {
        waits(|pause| fetch_intervals(&server.base, Some(KEY), IntervalsKind::Wellness, OCT_25, NOV_17, pause))
    }

    fn header<'a>(head: &'a str, name: &str) -> Option<&'a str> {
        head.lines().find_map(|line| {
            let (found, value) = line.split_once(':')?;
            found.eq_ignore_ascii_case(name).then(|| value.trim())
        })
    }

    #[test]
    fn urls_are_built_here_for_the_two_hosts_and_nothing_else() {
        assert_eq!(
            intervals_url(INTERVALS_BASE, IntervalsKind::Wellness, OCT_25, NOV_17).unwrap(),
            "https://intervals.icu/api/v1/athlete/0/wellness?oldest=2026-10-25&newest=2026-11-17"
        );
        assert_eq!(
            intervals_url(INTERVALS_BASE, IntervalsKind::Activities, OCT_25, NOV_17).unwrap(),
            "https://intervals.icu/api/v1/athlete/0/activities?oldest=2026-10-25T00:00:00&newest=2026-11-17T23:59:59"
        );
        assert_eq!(
            weather_url(OPEN_METEO_BASE, 37.8, -122.27, OCT_25, NOV_17).unwrap(),
            "https://api.open-meteo.com/v1/forecast?latitude=37.8&longitude=-122.27\
             &daily=temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code\
             &temperature_unit=celsius&precipitation_unit=mm&timezone=auto&start_date=2026-10-25&end_date=2026-11-17"
        );
        assert_eq!(
            weather_url(OPEN_METEO_BASE, 0.0, 180.0, NOV_17, NOV_17).unwrap().split('&').next().unwrap(),
            "https://api.open-meteo.com/v1/forecast?latitude=0"
        );
    }

    #[test]
    fn only_wellness_and_activities_can_be_asked_for() {
        assert_eq!(serde_json::from_str::<IntervalsKind>("\"wellness\"").unwrap(), IntervalsKind::Wellness);
        assert_eq!(serde_json::from_str::<IntervalsKind>("\"activities\"").unwrap(), IntervalsKind::Activities);
        for other in ["\"athlete\"", "\"wellness/../../oauth\"", "\"Wellness\"", "\"\"", "0"] {
            assert!(serde_json::from_str::<IntervalsKind>(other).is_err(), "{other}");
        }
    }

    #[test]
    fn anything_that_is_not_a_day_or_a_place_is_refused_before_a_request_is_made() {
        let dead = dead_base();
        let not_days = [
            "", "2026-11-7", "2026-13-01", "2026-00-10", "2026-11-00", "2026-11-32", "20261117xx", "2026-11-17T00:00",
            "2026-11-17&x=1", "2026/11/17", "2026-11-1７", " 2026-11-17", "../../../etc",
        ];
        for bad in not_days {
            for (oldest, newest) in [(bad, NOV_17), (OCT_25, bad)] {
                let (result, _) =
                    waits(|pause| fetch_intervals(&dead, Some(KEY), IntervalsKind::Wellness, oldest, newest, pause));
                assert_eq!(result, Err(unexpected("a day to fetch was not a date")), "{bad:?}");
                let (result, _) = waits(|pause| fetch_weather(&dead, 37.8, -122.27, oldest, newest, pause));
                assert_eq!(result, Err(unexpected("a day to fetch was not a date")), "{bad:?}");
            }
        }
        for (oldest, newest) in [(NOV_17, OCT_25), ("2024-11-17", NOV_17)] {
            assert_eq!(days(oldest, newest), Err(unexpected("the days to fetch were not a range")));
        }
        assert!(days(NOV_17, NOV_17).is_ok());
        assert!(days("2025-12-25", "2026-01-15").is_ok());
        for (latitude, longitude) in [(90.1, 0.0), (-91.0, 0.0), (0.0, 180.5), (0.0, -181.0), (f64::NAN, 0.0), (0.0, f64::INFINITY)] {
            let (result, _) = waits(|pause| fetch_weather(&dead, latitude, longitude, OCT_25, NOV_17, pause));
            assert_eq!(
                result,
                Err(unexpected("the place to fetch weather for was not a latitude and longitude")),
                "{latitude}, {longitude}"
            );
        }
    }

    #[test]
    fn the_key_goes_into_basic_auth_with_the_user_api_key() {
        // base64("API_KEY:test-key-3f9a")
        assert_eq!(basic_auth(KEY), "Basic QVBJX0tFWTp0ZXN0LWtleS0zZjlh");
        let server = Server::answering(vec![(200, "", r#"[{"id":"2026-11-17","hrv":69.0}]"#)]);
        let (result, waited) = wellness(&server);
        assert_eq!(result, Ok(json!([{ "id": "2026-11-17", "hrv": 69.0 }])));
        assert!(waited.is_empty());
        let requests = server.requests();
        assert_eq!(requests.len(), 1);
        assert!(
            requests[0].starts_with("GET /api/v1/athlete/0/wellness?oldest=2026-10-25&newest=2026-11-17 HTTP/1.1\r\n"),
            "{}",
            requests[0]
        );
        assert_eq!(header(&requests[0], "authorization"), Some("Basic QVBJX0tFWTp0ZXN0LWtleS0zZjlh"));
        assert!(header(&requests[0], "user-agent").unwrap().starts_with("Wetware/"));
    }

    #[test]
    fn with_no_key_nothing_is_sent() {
        let server = Server::answering(vec![]);
        let (result, _) =
            waits(|pause| fetch_intervals(&server.base, None, IntervalsKind::Activities, OCT_25, NOV_17, pause));
        assert_eq!(result, Err(SyncError::NoKey));
        assert!(server.requests().is_empty());
    }

    #[test]
    fn weather_is_asked_for_without_any_authorization() {
        let body = r#"{"daily":{"time":["2026-11-17"],"temperature_2m_max":[8.5]}}"#;
        let server = Server::answering(vec![(200, "", body)]);
        let (result, _) = waits(|pause| fetch_weather(&server.base, 52.52, 13.41, OCT_25, NOV_17, pause));
        assert_eq!(result, Ok(json!({ "daily": { "time": ["2026-11-17"], "temperature_2m_max": [8.5] } })));
        let requests = server.requests();
        assert!(requests[0].starts_with("GET /v1/forecast?latitude=52.52&longitude=13.41&daily="), "{}", requests[0]);
        assert_eq!(header(&requests[0], "authorization"), None);
    }

    #[test]
    fn a_key_that_is_turned_down_is_reported_as_that() {
        for status in [401, 403] {
            let server = Server::answering(vec![(status, "", r#"{"error":"Access denied"}"#)]);
            assert_eq!(wellness(&server).0, Err(SyncError::KeyRejected), "{status}");
            assert_eq!(server.requests().len(), 1);
        }
        // Open-Meteo takes no key, so a 401 from it isn't about one.
        let server = Server::answering(vec![(401, "", "{}")]);
        let (result, _) = waits(|pause| fetch_weather(&server.base, 52.52, 13.41, OCT_25, NOV_17, pause));
        assert_eq!(result, Err(unexpected("HTTP 401")));
    }

    #[test]
    fn a_429_is_retried_after_the_wait_the_server_asks_for() {
        let server = Server::answering(vec![
            (429, "Retry-After: 7\r\n", ""),
            (429, "retry-after: 12\r\n", ""),
            (200, "", "[]"),
        ]);
        let (result, waited) = wellness(&server);
        assert_eq!(result, Ok(json!([])));
        assert_eq!(waited, [7, 12]);
        assert_eq!(server.requests().len(), 3);
    }

    #[test]
    fn a_429_with_no_wait_named_backs_off_further_each_time_and_then_gives_up() {
        let server = Server::answering(vec![(429, "", ""); MAX_RETRIES + 1]);
        let (result, waited) = wellness(&server);
        assert_eq!(result, Err(SyncError::RateLimited { retry_after_secs: None }));
        assert_eq!(waited, [2, 4, 8]);
        assert_eq!(server.requests().len(), MAX_RETRIES + 1);
    }

    #[test]
    fn a_429_that_asks_for_a_long_wait_is_not_waited_out() {
        let server = Server::answering(vec![(429, "Retry-After: 3600\r\n", "")]);
        let (result, waited) = wellness(&server);
        assert_eq!(result, Err(SyncError::RateLimited { retry_after_secs: Some(3600) }));
        assert!(waited.is_empty());
        assert_eq!(server.requests().len(), 1);
        // A date instead of seconds isn't understood: back off as if nothing was said.
        let server = Server::answering(vec![(429, "Retry-After: Wed, 18 Nov 2026 07:28:00 GMT\r\n", ""), (200, "", "[]")]);
        let (result, waited) = wellness(&server);
        assert_eq!(result, Ok(json!([])));
        assert_eq!(waited, [2]);
    }

    #[test]
    fn other_statuses_are_reported_by_number_and_not_retried() {
        for status in [400, 404, 500, 503] {
            let server = Server::answering(vec![(status, "", r#"{"error":"SECRET-BODY"}"#)]);
            let (result, waited) = wellness(&server);
            assert_eq!(result, Err(unexpected(format!("HTTP {status}"))));
            assert!(waited.is_empty());
            assert_eq!(server.requests().len(), 1);
        }
    }

    #[test]
    fn a_redirect_is_not_followed_so_the_key_goes_nowhere_else() {
        let elsewhere = Server::answering(vec![]);
        let location: &'static str = Box::leak(format!("Location: {}/collect\r\n", elsewhere.base).into_boxed_str());
        let server = Server::answering(vec![(302, location, "")]);
        assert_eq!(wellness(&server).0, Err(unexpected("HTTP 302")));
        assert_eq!(server.requests().len(), 1);
        assert!(elsewhere.requests().is_empty());
    }

    #[test]
    fn a_body_that_is_not_what_was_asked_for_is_unexpected() {
        let server = Server::answering(vec![(200, "", "<html>Sign in</html>")]);
        assert_eq!(wellness(&server).0, Err(unexpected("the response was not JSON")));
        let server = Server::answering(vec![(200, "", r#"{"error":"nope"}"#)]);
        assert_eq!(wellness(&server).0, Err(unexpected("the response was not a list")));
        let server = Server::answering(vec![(200, "", "[1,2]")]);
        let (result, _) = waits(|pause| fetch_weather(&server.base, 52.52, 13.41, OCT_25, NOV_17, pause));
        assert_eq!(result, Err(unexpected("the response was not a set of daily values")));
    }

    #[test]
    fn no_answer_at_all_is_offline() {
        let dead = dead_base();
        let (result, waited) =
            waits(|pause| fetch_intervals(&dead, Some(KEY), IntervalsKind::Wellness, OCT_25, NOV_17, pause));
        assert_eq!(result, Err(SyncError::Offline));
        assert!(waited.is_empty());
        let (result, _) = waits(|pause| fetch_weather(&dead, 52.52, 13.41, OCT_25, NOV_17, pause));
        assert_eq!(result, Err(SyncError::Offline));
    }

    /// Calls the real Open-Meteo, which needs no key, for Berlin. Not run by
    /// default: `cargo test -- --ignored`. There is no such test for
    /// intervals.icu, which is never called without the user's own key.
    #[test]
    #[ignore = "uses the network"]
    fn open_meteo_answers_the_url_built_here() {
        let days = fetch_weather(OPEN_METEO_BASE, 52.52, 13.41, "2026-11-10", "2026-11-12", &mut |_| {}).unwrap();
        assert_eq!(days["daily"]["time"], json!(["2026-11-10", "2026-11-11", "2026-11-12"]));
        assert_eq!(days["daily_units"]["temperature_2m_max"], "°C");
        assert_eq!(days["daily_units"]["precipitation_sum"], "mm");
        for series in ["temperature_2m_max", "temperature_2m_min", "precipitation_sum", "weather_code"] {
            assert_eq!(days["daily"][series].as_array().map(Vec::len), Some(3), "{series}");
        }
    }

    #[test]
    fn activities_are_cut_down_to_what_the_app_reads() {
        let body = r#"[
            {"id":"i1","start_date_local":"2026-11-17T06:12:44","type":"Run","source":"GARMIN_CONNECT","moving_time":2754,
             "elapsed_time":2868,"name":"Morning Run","average_heartrate":138,"icu_training_load":43,"description":"private"},
            {"id":"2","start_date_local":"2026-11-08T09:14:03","source":"STRAVA","_note":"STRAVA activities are not available via the API","icu_athlete_id":"i000000"},
            7
        ]"#;
        let server = Server::answering(vec![(200, "", Box::leak(body.to_string().into_boxed_str()))]);
        let (result, _) =
            waits(|pause| fetch_intervals(&server.base, Some(KEY), IntervalsKind::Activities, OCT_25, NOV_17, pause));
        assert_eq!(
            result,
            Ok(json!([
                { "id": "i1", "start_date_local": "2026-11-17T06:12:44", "type": "Run", "source": "GARMIN_CONNECT", "moving_time": 2754, "elapsed_time": 2868 },
                { "id": "2", "start_date_local": "2026-11-08T09:14:03", "source": "STRAVA", "_note": "STRAVA activities are not available via the API" },
                7
            ]))
        );
        let requests = server.requests();
        assert!(
            requests[0].starts_with(
                "GET /api/v1/athlete/0/activities?oldest=2026-10-25T00:00:00&newest=2026-11-17T23:59:59 HTTP/1.1\r\n"
            ),
            "{}",
            requests[0]
        );
    }

    #[test]
    fn errors_reach_the_webview_as_a_kind_and_carry_no_key_or_body() {
        let shape = |error: SyncError| serde_json::to_value(error).unwrap();
        assert_eq!(shape(SyncError::NoKey), json!({ "kind": "no_key" }));
        assert_eq!(shape(SyncError::KeyRejected), json!({ "kind": "key_rejected" }));
        assert_eq!(shape(SyncError::Offline), json!({ "kind": "offline" }));
        assert_eq!(
            shape(SyncError::RateLimited { retry_after_secs: Some(30) }),
            json!({ "kind": "rate_limited", "retry_after_secs": 30 })
        );
        assert_eq!(
            shape(SyncError::RateLimited { retry_after_secs: None }),
            json!({ "kind": "rate_limited", "retry_after_secs": null })
        );
        assert_eq!(shape(unexpected("HTTP 500")), json!({ "kind": "unexpected", "detail": "HTTP 500" }));

        // Every way a fetch with a key can fail: none of the errors mentions the key, the header or the body.
        let failures: Vec<Vec<Canned>> = vec![
            vec![(401, "", "SECRET-BODY")],
            vec![(500, "", "SECRET-BODY")],
            vec![(200, "", "SECRET-BODY")],
            vec![(200, "", r#"{"secret":"SECRET-BODY"}"#)],
            vec![(429, "Retry-After: 99\r\n", "SECRET-BODY")],
            vec![(302, "Location: http://127.0.0.1:9/SECRET-BODY\r\n", "")],
        ];
        let mut errors = vec![fetch_intervals(&dead_base(), Some(KEY), IntervalsKind::Wellness, OCT_25, NOV_17, &mut |_| {})];
        for responses in failures {
            let server = Server::answering(responses);
            errors.push(wellness(&server).0);
        }
        for error in errors {
            let error = error.unwrap_err();
            let said = format!("{error:?} {}", serde_json::to_string(&error).unwrap());
            for secret in [KEY, "QVBJX0tFWTp0ZXN0LWtleS0zZjlh", "SECRET-BODY", "Basic"] {
                assert!(!said.contains(secret), "{said}");
            }
        }
    }
}
