//! dexterm popup host — wry/tao shell (task-1290; productionised from the spike shell).
//!
//! One process hosts N frameless, transparent, rounded (CSS), always-on-top WebView windows.
//! Control protocol = JSON lines on stdin (from the TUI), events = JSON lines on stdout.
//! The popup URL (which carries a single-use ticket) is passed over stdin, never on argv,
//! so `ps` from another local user cannot read it.
//!
//! The global hotkey chord is read from the DEXTERM_POPUP_HOTKEY environment variable (an accelerator
//! like "Control+Alt+Super+Shift+KeyB"); an empty value disables it and a malformed value falls back to
//! the default chord. Occlusion detection stays ON (unlike the spike's measurement flag): WebKit pauses
//! rendering behind a locked/occluded screen, which is correct for battery and matches the HUD design.
//!
//! stdin ops:  {"op":"open","id":"w1","url":"http://127.0.0.1:PORT/popup/chart?p=TICKET","x":60,"y":60,"w":960,"h":640,"ontop":true,"focus":false}
//!             {"op":"close","id":"w1"} {"op":"show","id":"w1"} {"op":"hide","id":"w1"} {"op":"focus","id":"w1"}
//!             {"op":"ontop","id":"w1","on":true} {"op":"clickthrough","id":"w1","on":true}
//!             {"op":"move","id":"w1","x":..,"y":..} {"op":"bounds","id":"w1","x":..,"y":..,"w":..,"h":..} {"op":"quit"}
//! stdout evs: {"ev":"shell.ready","shell":"wry","t_ms":..,"hotkey_registered":true,"hotkey":"...","hotkey_close_registered":true,"hotkey_close":"..."}
//!             {"ev":"window.created","id":..,"t_ms":..,"create_ms":..} {"ev":"ipc","id":..,"msg":<json from page>}
//!             {"ev":"hotkey","accel":"...","action":"toggle"|"close"} {"ev":"window.closed","id":..} {"ev":"error","msg":..}
//!
//! task-1325: the app runs as an ACCESSORY (no Dock icon, no menu bar takeover), windows open unfocused by
//! default (the terminal keeps the keyboard; click the chart to use its keys), `bounds` docks/follows the
//! terminal, a second global chord (DEXTERM_POPUP_HOTKEY_CLOSE) closes every popup, the page's own
//! `close-request` / `drag` IPC is acted on here (closing never depends on the TUI), and new-window
//! requests (target=_blank links) are denied.
use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::net::Ipv4Addr;
use std::str::FromStr;
use std::time::Instant;

use global_hotkey::hotkey::HotKey;
use global_hotkey::{GlobalHotKeyEvent, GlobalHotKeyManager};
use serde::Deserialize;
use tao::dpi::{LogicalPosition, LogicalSize};
use tao::event::{Event, StartCause, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder};
use tao::window::{Window, WindowBuilder};
use url::{Host, Url};
use wry::NewWindowResponse;
use wry::WebView;
use wry::WebViewBuilder;
use wry::{ProxyConfig, ProxyEndpoint};
#[cfg(target_os = "macos")]
use tao::platform::macos::{ActivationPolicy, EventLoopExtMacOS};

const DEFAULT_HOTKEY: &str = "Control+Alt+Super+Shift+KeyB";
const DEFAULT_HOTKEY_CLOSE: &str = "Control+Alt+Super+Shift+KeyW";

/// A popup WebView may only ever load or navigate to our own loopback server origin,
/// `http://127.0.0.1:<port>/…` (plus `about:blank`, the refused-URL placeholder). Pinning navigation in
/// the shell itself is defence in depth behind the TUI-side URL check and the page CSP: any navigation
/// attempt off that origin (a planted link, a redirect) is refused so a remote page can never be rendered
/// in a frameless always-on-top window.
///
/// This is a PARSED comparison, not a string prefix (the earlier `starts_with("http://127.0.0.1:")` let
/// `http://127.0.0.1:1@evil.example/` through: its host is evil.example, the "127.0.0.1:1" is userinfo).
/// Scheme must be http, there must be no userinfo at all, the host must be exactly the IPv4 127.0.0.1
/// after WHATWG normalisation (`localhost`, `[::1]` and any domain such as `127.0.0.1.evil.example` are
/// refused: the TUI server only answers `Host: 127.0.0.1:<port>`; spellings that normalise to the same
/// IPv4 — `0x7f.1`, `2130706433`, `127.0.0.1.` — are that host), and the port (default 80 when omitted)
/// must equal `port`. With no pinned
/// port (an `open` op that carried none and whose URL did not parse) nothing but `about:blank` is allowed.
fn nav_allowed(raw: &str, port: Option<u16>) -> bool {
    if raw == "about:blank" {
        return true;
    }
    let Some(port) = port else { return false };
    let Ok(u) = Url::parse(raw) else { return false };
    if u.scheme() != "http" {
        return false;
    }
    if !u.username().is_empty() || u.password().is_some() {
        return false;
    }
    if u.host() != Some(Host::Ipv4(Ipv4Addr::new(127, 0, 0, 1))) {
        return false;
    }
    u.port_or_known_default() == Some(port)
}

/// The port a window is pinned to: the `open` op's explicit `port`, else the port of the requested URL
/// itself (which the TUI has already pinned to its server) when that URL is a loopback http URL.
fn pinned_port(op_port: Option<u16>, requested: &str) -> Option<u16> {
    if op_port.is_some() {
        return op_port;
    }
    let u = Url::parse(requested).ok()?;
    let p = u.port_or_known_default()?;
    if nav_allowed(requested, Some(p)) { Some(p) } else { None }
}

/// task-1358 r4: the sink proxy address from `DEXTERM_POPUP_PROXY`. Exactly `127.0.0.1:<1..65535>` — a proxy on any
/// other host would be a place to send every popup's traffic, so anything else is refused (the shell then runs
/// without a proxy and says so in `shell.ready`, and the TUI refuses to open pack widgets).
fn parse_sink_proxy(raw: &str) -> Option<(String, String)> {
    let (host, port) = raw.trim().rsplit_once(':')?;
    if host != "127.0.0.1" {
        return None;
    }
    let p: u16 = port.parse().ok()?;
    if p == 0 {
        return None;
    }
    Some((host.to_string(), p.to_string()))
}

#[cfg(test)]
mod tests {
    use super::{nav_allowed, parse_sink_proxy, pinned_port};

    #[test]
    fn sink_proxy_must_be_loopback() {
        assert_eq!(parse_sink_proxy("127.0.0.1:4100"), Some(("127.0.0.1".to_string(), "4100".to_string())));
        assert_eq!(parse_sink_proxy(" 127.0.0.1:65535 "), Some(("127.0.0.1".to_string(), "65535".to_string())));
        assert_eq!(parse_sink_proxy("127.0.0.1:0"), None);
        assert_eq!(parse_sink_proxy("127.0.0.1:70000"), None);
        assert_eq!(parse_sink_proxy("127.0.0.1"), None);
        assert_eq!(parse_sink_proxy("localhost:4100"), None);
        assert_eq!(parse_sink_proxy("0.0.0.0:4100"), None);
        assert_eq!(parse_sink_proxy("evil.example:3128"), None);
        assert_eq!(parse_sink_proxy("[::1]:4100"), None);
        assert_eq!(parse_sink_proxy(""), None);
    }

    const P: u16 = 5000;

    #[test]
    fn allows_only_our_origin() {
        assert!(nav_allowed("about:blank", None));
        assert!(nav_allowed("about:blank", Some(P)));
        assert!(nav_allowed("http://127.0.0.1:5000/popup/chart?p=ticket", Some(P)));
        assert!(nav_allowed("http://127.0.0.1:5000/", Some(P)));
        assert!(nav_allowed("http://127.0.0.1:5000/a/b#frag", Some(P)));
        // scheme is case-insensitive per WHATWG; this IS our origin
        assert!(nav_allowed("HTTP://127.0.0.1:5000/", Some(P)));
        // no pinned port: nothing but about:blank
        assert!(!nav_allowed("http://127.0.0.1:5000/", None));
    }

    #[test]
    fn refuses_userinfo_tricks() {
        // the reported bypass: "127.0.0.1:1" is userinfo, the host is evil.example
        assert!(!nav_allowed("http://127.0.0.1:1@evil.example/phish", Some(P)));
        assert!(!nav_allowed("http://127.0.0.1:5000@evil.example/", Some(P)));
        assert!(!nav_allowed("http://127.0.0.1:80@evil.example:443/", Some(P)));
        assert!(!nav_allowed("http://localhost:x@evil.example/", Some(P)));
        assert!(!nav_allowed("http://[::1]:1@evil.example/", Some(P)));
        // userinfo on our own host is refused too
        assert!(!nav_allowed("http://user@127.0.0.1:5000/", Some(P)));
        assert!(!nav_allowed("http://user:pw@127.0.0.1:5000/", Some(P)));
        assert!(!nav_allowed("http://:pw@127.0.0.1:5000/", Some(P)));
        // a bare `@` is EMPTY userinfo per WHATWG (username "", no password) and the host is ours → allowed
        assert!(nav_allowed("http://@127.0.0.1:5000/", Some(P)));
    }

    #[test]
    fn refuses_other_hosts_and_schemes() {
        assert!(!nav_allowed("https://127.0.0.1:5000/", Some(P)));
        assert!(!nav_allowed("https://evil.example/", Some(P)));
        assert!(!nav_allowed("http://evil.example/", Some(P)));
        assert!(!nav_allowed("http://localhost:5000/", Some(P)));
        assert!(!nav_allowed("http://[::1]:5000/", Some(P)));
        assert!(!nav_allowed("http://127.0.0.1.evil.example:5000/", Some(P)));
        // a trailing dot is stripped by the WHATWG IPv4 parser (same in Node's URL): it IS 127.0.0.1 → allowed
        assert!(nav_allowed("http://127.0.0.1.:5000/", Some(P)));
        assert_eq!(url::Url::parse("http://127.0.0.1.:5000/").unwrap().host_str(), Some("127.0.0.1"));
        assert!(!nav_allowed("file:///etc/passwd", Some(P)));
        assert!(!nav_allowed("javascript:alert(1)", Some(P)));
        assert!(!nav_allowed("data:text/html,hi", Some(P)));
        assert!(!nav_allowed("", Some(P)));
        assert!(!nav_allowed("not a url", Some(P)));
    }

    #[test]
    fn pins_the_port() {
        assert!(!nav_allowed("http://127.0.0.1:5001/", Some(P)));
        assert!(!nav_allowed("http://127.0.0.1:9/other-local-service", Some(P)));
        assert!(!nav_allowed("http://127.0.0.1/", Some(P)), "no port means 80, not ours");
        assert!(nav_allowed("http://127.0.0.1/", Some(80)));
        assert!(nav_allowed("http://127.0.0.1:80/", Some(80)));
        assert!(!nav_allowed("http://127.0.0.1:65536/", Some(P)), "out-of-range port does not parse");
    }

    #[test]
    fn backslash_and_encoded_host_forms_never_escape_our_origin() {
        // WHATWG treats `\` like `/` for http: these are our origin with an odd path (allowed) or
        // refused — never evil.example.
        for s in ["http:\\\\127.0.0.1:5000\\x", "http://127.0.0.1:5000\\@evil.example/", "http://127.0.0.1:5000/\\evil.example"] {
            if nav_allowed(s, Some(P)) {
                let u = url::Url::parse(s).unwrap();
                assert_eq!(u.host_str(), Some("127.0.0.1"), "{s}");
                assert_eq!(u.port_or_known_default(), Some(P), "{s}");
            }
        }
        assert!(!nav_allowed("http://evil.example\\@127.0.0.1:5000/", Some(P)));
        // percent-encoded host bytes: either normalised to our IPv4 (allowed) or refused — never another host
        for s in ["http://127.0.0.%31:5000/", "http://%31%32%37.0.0.1:5000/", "http://127.0.0.1%2Eevil.example:5000/"] {
            if nav_allowed(s, Some(P)) {
                assert_eq!(url::Url::parse(s).unwrap().host_str(), Some("127.0.0.1"), "{s}");
            }
        }
        assert!(!nav_allowed("http://127.0.0.1%40evil.example:5000/", Some(P)) || url::Url::parse("http://127.0.0.1%40evil.example:5000/").unwrap().host_str() == Some("127.0.0.1"));
        // alternative loopback spellings normalise to the IPv4 and are our host
        assert!(nav_allowed("http://2130706433:5000/", Some(P)));
        assert!(nav_allowed("http://0x7f.1:5000/", Some(P)));
        assert!(nav_allowed("http://0x7f000001:5000/", Some(P)));
    }

    #[test]
    fn pinned_port_prefers_the_op_then_the_url() {
        assert_eq!(pinned_port(Some(4321), "http://127.0.0.1:5000/"), Some(4321));
        assert_eq!(pinned_port(None, "http://127.0.0.1:5000/popup/chart?p=t"), Some(5000));
        assert_eq!(pinned_port(None, "http://127.0.0.1:1@evil.example/"), None);
        assert_eq!(pinned_port(None, "https://127.0.0.1:5000/"), None);
        assert_eq!(pinned_port(None, "about:blank"), None);
        assert_eq!(pinned_port(None, "garbage"), None);
    }
}

#[derive(Debug, Deserialize)]
struct Op {
    op: String,
    id: Option<String>,
    url: Option<String>,
    /// `open` only: the TUI server's port; every navigation of the window is pinned to http://127.0.0.1:port.
    port: Option<u16>,
    x: Option<f64>,
    y: Option<f64>,
    w: Option<f64>,
    h: Option<f64>,
    on: Option<bool>,
    ontop: Option<bool>,
    /// `open` only: take keyboard focus (default false — the terminal keeps it).
    focus: Option<bool>,
}

#[derive(Debug)]
enum UserEvent {
    Op(Op),
    Ipc(String, String),
}

struct Popup {
    window: Window,
    #[allow(dead_code)]
    webview: WebView,
}

fn emit(s: String) {
    let out = std::io::stdout();
    let mut lock = out.lock();
    let _ = writeln!(lock, "{}", s);
    let _ = lock.flush();
}

fn quit_op() -> Op {
    Op { op: "quit".into(), id: None, url: None, port: None, x: None, y: None, w: None, h: None, on: None, ontop: None, focus: None }
}

fn main() {
    let t0 = Instant::now();
    #[allow(unused_mut)]
    let mut event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    #[cfg(target_os = "macos")]
    event_loop.set_activation_policy(ActivationPolicy::Accessory);
    let proxy = event_loop.create_proxy();

    // stdin → event loop
    {
        let proxy = proxy.clone();
        std::thread::spawn(move || {
            let stdin = std::io::stdin();
            for line in stdin.lock().lines() {
                let Ok(line) = line else { break };
                if line.trim().is_empty() {
                    continue;
                }
                match serde_json::from_str::<Op>(&line) {
                    Ok(op) => {
                        if proxy.send_event(UserEvent::Op(op)).is_err() {
                            break;
                        }
                    }
                    Err(e) => emit(format!("{{\"ev\":\"error\",\"msg\":\"bad op: {}\"}}", e)),
                }
            }
            // stdin closed → the TUI is gone → quit
            let _ = proxy.send_event(UserEvent::Op(quit_op()));
        });
    }

    // global hotkey from DEXTERM_POPUP_HOTKEY (configurable; registered via Carbon, no Accessibility perm).
    let chord = std::env::var("DEXTERM_POPUP_HOTKEY").unwrap_or_else(|_| DEFAULT_HOTKEY.to_string());
    let hk_manager = GlobalHotKeyManager::new().expect("hotkey manager");
    let (hk_ok, accel) = if chord.trim().is_empty() {
        (false, String::new())
    } else {
        let parsed = HotKey::from_str(&chord).or_else(|_| HotKey::from_str(DEFAULT_HOTKEY));
        match parsed {
            Ok(hk) => {
                let a = if HotKey::from_str(&chord).is_ok() { chord.clone() } else { DEFAULT_HOTKEY.to_string() };
                (hk_manager.register(hk).is_ok(), a)
            }
            Err(_) => (false, String::new()),
        }
    };
    // task-1325: a second chord closes every popup (DEXTERM_POPUP_HOTKEY_CLOSE; empty disables).
    let close_chord = std::env::var("DEXTERM_POPUP_HOTKEY_CLOSE").unwrap_or_else(|_| DEFAULT_HOTKEY_CLOSE.to_string());
    let (hk_close_ok, accel_close, close_id) = if close_chord.trim().is_empty() {
        (false, String::new(), None)
    } else {
        let a = if HotKey::from_str(&close_chord).is_ok() { close_chord.clone() } else { DEFAULT_HOTKEY_CLOSE.to_string() };
        match HotKey::from_str(&a) {
            Ok(hk) => (hk_manager.register(hk).is_ok(), a, Some(hk.id())),
            Err(_) => (false, String::new(), None),
        }
    };
    let hk_rx = GlobalHotKeyEvent::receiver().clone();

    // task-1358 r4: DEXTERM_POPUP_PROXY = "127.0.0.1:<port>" — the host's loopback SINK PROXY. Every connection a
    // WebView makes (page loads, the WebSocket, and the one thing no CSP directive covers: a runtime
    // `<link rel=preconnect>` to a page-chosen host:port) goes through it, and it tunnels only to the popup server's
    // own origin. Only a loopback proxy is accepted; anything else is ignored and reported, never used.
    let sink_proxy = match std::env::var("DEXTERM_POPUP_PROXY") {
        Ok(v) => match parse_sink_proxy(&v) {
            Some(p) => Some(p),
            None => {
                emit(format!(
                    "{{\"ev\":\"error\",\"msg\":{}}}",
                    serde_json::to_string(&format!("ignored DEXTERM_POPUP_PROXY (not 127.0.0.1:<port>): {}", v.chars().take(40).collect::<String>())).unwrap()
                ));
                None
            }
        },
        Err(_) => None,
    };

    let mut popups: HashMap<String, Popup> = HashMap::new();
    let mut hidden: HashMap<String, bool> = HashMap::new();

    event_loop.run(move |event, target, control_flow| {
        *control_flow = ControlFlow::Wait;
        // poll hotkey channel (cheap; the loop wakes on any event anyway)
        while let Ok(ev) = hk_rx.try_recv() {
            if ev.state == global_hotkey::HotKeyState::Pressed {
                let is_close = close_id == Some(ev.id);
                emit(format!(
                    "{{\"ev\":\"hotkey\",\"accel\":{},\"action\":\"{}\",\"t_ms\":{}}}",
                    serde_json::to_string(if is_close { &accel_close } else { &accel }).unwrap(),
                    if is_close { "close" } else { "toggle" },
                    t0.elapsed().as_millis()
                ));
                if is_close {
                    let ids: Vec<String> = popups.keys().cloned().collect();
                    for id in ids {
                        popups.remove(&id);
                        hidden.remove(&id);
                        emit(format!("{{\"ev\":\"window.closed\",\"id\":{}}}", serde_json::to_string(&id).unwrap()));
                    }
                } else {
                    for (id, p) in popups.iter() {
                        let h = hidden.get(id).copied().unwrap_or(false);
                        p.window.set_visible(h);
                        if h {
                            p.window.set_focus();
                        }
                        hidden.insert(id.clone(), !h);
                    }
                }
            }
        }
        match event {
            Event::NewEvents(StartCause::Init) => {
                emit(format!(
                    "{{\"ev\":\"shell.ready\",\"shell\":\"wry\",\"t_ms\":{},\"hotkey_registered\":{},\"hotkey\":{},\"hotkey_close_registered\":{},\"hotkey_close\":{},\"sink_proxy\":{}}}",
                    t0.elapsed().as_millis(),
                    hk_ok,
                    serde_json::to_string(&accel).unwrap(),
                    hk_close_ok,
                    serde_json::to_string(&accel_close).unwrap(),
                    match &sink_proxy { Some((h, p)) => serde_json::to_string(&format!("{}:{}", h, p)).unwrap(), None => "null".to_string() }
                ));
            }
            Event::UserEvent(UserEvent::Ipc(id, msg)) => {
                // The page's IPC body is untrusted: validate it is well-formed JSON and re-serialise it
                // before splicing into our stdout protocol, so a crafted body (embedded newline, extra
                // fields) can never forge a shell event on the TUI's line-oriented stdin parser.
                match serde_json::from_str::<serde_json::Value>(&msg) {
                    Ok(v) => {
                        emit(format!(
                            "{{\"ev\":\"ipc\",\"id\":{},\"msg\":{}}}",
                            serde_json::to_string(&id).unwrap(),
                            serde_json::to_string(&v).unwrap()
                        ));
                        // task-1325: the page may only ask to drag or close ITS OWN window.
                        match v.get("type").and_then(|t| t.as_str()) {
                            Some("close-request") => {
                                if popups.remove(&id).is_some() {
                                    hidden.remove(&id);
                                    emit(format!("{{\"ev\":\"window.closed\",\"id\":{}}}", serde_json::to_string(&id).unwrap()));
                                }
                            }
                            Some("drag") => {
                                if let Some(p) = popups.get(&id) {
                                    let _ = p.window.drag_window();
                                }
                            }
                            _ => {}
                        }
                    }
                    Err(_) => emit(format!(
                        "{{\"ev\":\"error\",\"msg\":{}}}",
                        serde_json::to_string(&format!("bad ipc from {}", id)).unwrap()
                    )),
                }
            }
            Event::UserEvent(UserEvent::Op(op)) => {
                let id = op.id.clone().unwrap_or_else(|| "w1".to_string());
                match op.op.as_str() {
                    "open" => {
                        let t_open = Instant::now();
                        let window = WindowBuilder::new()
                            .with_title("dexterm")
                            .with_decorations(false)
                            .with_transparent(true)
                            .with_always_on_top(op.ontop.unwrap_or(true))
                            .with_visible_on_all_workspaces(true)
                            .with_position(LogicalPosition::new(op.x.unwrap_or(80.0), op.y.unwrap_or(80.0)))
                            .with_inner_size(LogicalSize::new(op.w.unwrap_or(960.0), op.h.unwrap_or(640.0)))
                            .with_focused(op.focus.unwrap_or(false))
                            .build(target)
                            .expect("window");
                        let proxy_ipc = proxy.clone();
                        let id_ipc = id.clone();
                        let requested = op.url.clone().unwrap_or_else(|| "about:blank".into());
                        // The origin this window is pinned to for its whole life: the op's port, else the
                        // requested URL's own (already TUI-enforced) port. Refuse an off-origin initial url
                        // outright (load about:blank instead) and report it.
                        let pinned = pinned_port(op.port, &requested);
                        let url = if nav_allowed(&requested, pinned) {
                            requested
                        } else {
                            emit(format!(
                                "{{\"ev\":\"error\",\"msg\":{}}}",
                                serde_json::to_string(&format!("refused non-loopback popup url for {}", id)).unwrap()
                            ));
                            "about:blank".to_string()
                        };
                        let mut builder = WebViewBuilder::new()
                            .with_url(&url)
                            .with_transparent(true)
                            .with_background_color((0, 0, 0, 0))
                            .with_devtools(false)
                            .with_navigation_handler(move |u: String| nav_allowed(&u, pinned))
                            .with_new_window_req_handler(|_, _| NewWindowResponse::Deny)
                            .with_ipc_handler(move |req| {
                                let body = req.body().to_string();
                                let _ = proxy_ipc.send_event(UserEvent::Ipc(id_ipc.clone(), body));
                            });
                        // r4: route every connection of this WebView through the host's loopback sink proxy (see main()).
                        if let Some((h, p)) = &sink_proxy {
                            builder = builder.with_proxy_config(ProxyConfig::Http(ProxyEndpoint { host: h.clone(), port: p.clone() }));
                        }
                        let webview = builder.build(&window).expect("webview");
                        emit(format!(
                            "{{\"ev\":\"window.created\",\"id\":{},\"t_ms\":{},\"create_ms\":{}}}",
                            serde_json::to_string(&id).unwrap(),
                            t0.elapsed().as_millis(),
                            t_open.elapsed().as_millis()
                        ));
                        popups.insert(id.clone(), Popup { window, webview });
                        hidden.insert(id, false);
                    }
                    "close" => {
                        if popups.remove(&id).is_some() {
                            hidden.remove(&id);
                            emit(format!("{{\"ev\":\"window.closed\",\"id\":{}}}", serde_json::to_string(&id).unwrap()));
                        }
                    }
                    "show" | "hide" => {
                        if let Some(p) = popups.get(&id) {
                            let show = op.op == "show";
                            p.window.set_visible(show);
                            hidden.insert(id, !show);
                        }
                    }
                    "focus" => {
                        if let Some(p) = popups.get(&id) {
                            p.window.set_focus();
                        }
                    }
                    "ontop" => {
                        if let Some(p) = popups.get(&id) {
                            p.window.set_always_on_top(op.on.unwrap_or(true));
                        }
                    }
                    "clickthrough" => {
                        if let Some(p) = popups.get(&id) {
                            let _ = p.window.set_ignore_cursor_events(op.on.unwrap_or(true));
                        }
                    }
                    "move" => {
                        if let Some(p) = popups.get(&id) {
                            p.window.set_outer_position(LogicalPosition::new(op.x.unwrap_or(0.0), op.y.unwrap_or(0.0)));
                        }
                    }
                    "bounds" => {
                        // task-1325: dock / follow the terminal (logical points, top-left origin)
                        if let Some(p) = popups.get(&id) {
                            p.window.set_outer_position(LogicalPosition::new(op.x.unwrap_or(0.0), op.y.unwrap_or(0.0)));
                            if let (Some(w), Some(h)) = (op.w, op.h) {
                                if w >= 200.0 && h >= 150.0 {
                                    p.window.set_inner_size(LogicalSize::new(w, h));
                                }
                            }
                        }
                    }
                    "drag" => {
                        if let Some(p) = popups.get(&id) {
                            let _ = p.window.drag_window();
                        }
                    }
                    "quit" => {
                        *control_flow = ControlFlow::Exit;
                    }
                    other => emit(format!("{{\"ev\":\"error\",\"msg\":\"unknown op {}\"}}", other)),
                }
            }
            Event::WindowEvent { event: WindowEvent::CloseRequested, window_id, .. } => {
                let key = popups.iter().find(|(_, p)| p.window.id() == window_id).map(|(k, _)| k.clone());
                if let Some(k) = key {
                    popups.remove(&k);
                    emit(format!("{{\"ev\":\"window.closed\",\"id\":{}}}", serde_json::to_string(&k).unwrap()));
                }
            }
            _ => {}
        }
    });
}
