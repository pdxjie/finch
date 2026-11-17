use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::db::{self, AppState, Session};
use crate::models::ConnectionProfile;

pub fn claim_due(session: &Session, profile: &ConnectionProfile, now: Instant) -> bool {
    if !profile.auto_reconnect && session.last_error.lock().unwrap().is_some() {
        return false;
    }
    let metrics = session.pool.metrics();
    // A busy pool is not evidence that MySQL disconnected. Retry on the next
    // scheduler tick instead of timing out and replacing a healthy pool.
    if metrics.connections_in_pool.load(Ordering::Relaxed) == 0
        && metrics.connections_in_use.load(Ordering::Relaxed) >= session.opts.pool_opts().constraints().max()
    {
        return false;
    }
    let mut last = session.last_heartbeat.lock().unwrap();
    if now.duration_since(*last) < Duration::from_secs(profile.keep_alive_seconds.max(1))
        || session.heartbeat_running.swap(true, Ordering::Relaxed)
    {
        return false;
    }
    *last = now;
    true
}

fn is_current(state: &AppState, session: &Arc<Session>) -> bool {
    state.session(&session.id).is_ok_and(|current| Arc::ptr_eq(&current, session))
}

pub async fn check(state: &AppState, session: &Arc<Session>) -> Vec<Value> {
    let outcome = db::ping_session(session).await;
    finish_check(state, session, outcome).await
}

/// Kept separate so a ping returning Err and a timeout share the same failure path.
pub async fn finish_check(
    state: &AppState,
    session: &Arc<Session>,
    outcome: Result<u64, String>,
) -> Vec<Value> {
    if !is_current(state, session) {
        return vec![];
    }
    match outcome {
        Ok(latency) => {
            let recovered = session.last_error.lock().unwrap().take().is_some();
            vec![json!({
                "type": if recovered { "session:status" } else { "session:ping" },
                "id": session.id, "status": "connected", "latency": latency,
                "error": "", "version": session.version,
            })]
        }
        Err(error) => {
            *session.last_error.lock().unwrap() = Some(error.clone());
            if !state.profile(&session.id).is_ok_and(|p| p.auto_reconnect) {
                return vec![json!({"type":"session:status", "id":session.id, "status":"error", "error":error})];
            }
            match db::reconnect_state(state, &session.id).await {
                Ok(reconnected) if is_current(state, &reconnected) => vec![json!({
                    "type":"session:status", "id":session.id, "status":"connected",
                    "reconnected":true, "version":reconnected.version, "latency":reconnected.latency,
                    "error":"", "attempt":0,
                })],
                Err(reconnect_error) if is_current(state, session) => vec![json!({
                    "type":"session:status", "id":session.id, "status":"error",
                    "error":format!("{error}；重连失败: {reconnect_error}"),
                })],
                _ => vec![],
            }
        }
    }
}
