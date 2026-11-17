//! Isolated MySQL regressions for connection policies and sync correctness.
use std::sync::{atomic::Ordering, Arc};
use std::time::{Duration, Instant};

use mysql_async::prelude::*;
use serde_json::json;

use crate::{db, ddl, heartbeat, models::*, query, schema, sync};

async fn context() -> Option<(db::AppState, Arc<db::Session>)> {
    let profile = ConnectionProfile {
        id: format!("finch-regression-{}", uuid::Uuid::new_v4().simple()),
        name: "Isolated policy regression".into(), category: "local".into(),
        host: "127.0.0.1".into(), port: 3407, user: "root".into(),
        database: "finch_demo".into(), keep_alive_seconds: 60,
        auto_reconnect: true, connect_timeout: 2000, ..Default::default()
    };
    let session = match db::open_session(&profile, "").await {
        Ok(session) => session,
        Err(error) => {
            assert!(std::env::var_os("FINCH_REQUIRE_MYSQL_TESTS").is_none(), "MySQL required: {error}");
            eprintln!("skipping MySQL regression: {error}");
            return None;
        }
    };
    let state = db::AppState::new();
    *state.profiles.lock().unwrap() = vec![profile.clone()];
    state.sessions.lock().unwrap().insert(profile.id, session.clone());
    Some((state, session))
}

fn payload(id: &str, database: &str, sql: &str) -> QueryPayload {
    QueryPayload { session_id: id.into(), database: database.into(), sql: sql.into(),
        max_rows: Some(100), auto_limit: Some(false), timeout_ms: Some(3000), ..Default::default() }
}

#[tokio::test]
async fn read_only_blocks_all_mutation_entries_and_live_setting_changes() {
    let Some((state, session)) = context().await else { return };
    let id = session.id.clone();
    let database = format!("finch_policy_{}", uuid::Uuid::new_v4().simple());
    let mut conn = session.pool.get_conn().await.unwrap();
    conn.query_drop(format!("CREATE DATABASE `{database}`")).await.unwrap();
    conn.query_drop(format!("CREATE TABLE `{database}`.t (id INT PRIMARY KEY, note VARCHAR(32))")).await.unwrap();
    conn.query_drop(format!("INSERT INTO `{database}`.t VALUES (1, 'original')")).await.unwrap();
    conn.query_drop(format!("CREATE FUNCTION `{database}`.mutate() RETURNS INT DETERMINISTIC MODIFIES SQL DATA BEGIN UPDATE `{database}`.t SET note='changed' WHERE id=1; RETURN 1; END")).await.unwrap();

    // Existing Session was opened read/write; a saved flag must still take effect immediately.
    state.profiles.lock().unwrap()[0].read_only = true;
    for sql in ["UPDATE t SET note='changed'", "WITH x AS (SELECT 1) DELETE FROM t", "/*!50000 DROP TABLE t */"] {
        assert!(query::execute(&state, payload(&id, &database, sql)).await.unwrap_err().contains("只读"));
    }
    let keys = json!({"id":1}).as_object().unwrap().clone();
    assert!(schema::update_cell(&state, UpdateCellPayload { session_id:id.clone(), database:database.clone(), table:"t".into(), column:"note".into(), value:json!("changed"), keys:keys.clone() }).await.unwrap_err().contains("只读"));
    assert!(schema::delete_rows(&state, DeleteRowsPayload { session_id:id.clone(), database:database.clone(), table:"t".into(), rows:vec![keys] }).await.unwrap_err().contains("只读"));
    assert!(schema::insert_row(&state, InsertRowPayload { session_id:id.clone(), database:database.clone(), table:"t".into(), values:json!({"id":2}).as_object().unwrap().clone() }).await.unwrap_err().contains("只读"));
    assert!(ddl::create_table(&state, CreateTableRequest { session_id:id.clone(), database:database.clone(), table:"new_table".into(), ..Default::default() }).await.unwrap_err().contains("只读"));
    assert!(ddl::alter_table(&state, AlterTableRequest { session_id:id.clone(), database:database.clone(), table:"t".into(), ..Default::default() }).await.unwrap_err().contains("只读"));
    assert!(ddl::drop_table(&state, &id, &database, "t").await.unwrap_err().contains("只读"));
    assert!(schema::kill_process(&state, &id, conn.id() as u64).await.unwrap_err().contains("只读"));
    let request = SyncRequest { source_id:id.clone(), target_id:id.clone(), source_database:"finch_demo".into(), target_database:database.clone(), tables:vec![SyncTable { name:"customers".into(), mode:"replace".into(), columns:vec![] }], create_missing:true, batch_size:Some(50), concurrency:Some(1) };
    assert!(sync::run(None, &state, request).await.unwrap_err().contains("只读"));

    let read = query::execute(&state, payload(&id, &database, "SELECT note FROM t")).await.unwrap();
    assert_eq!(read.statements[0].rows[0][0], json!("original"));
    let hidden_write = query::execute(&state, payload(&id, &database, "SELECT mutate()" )).await.unwrap();
    assert_eq!(hidden_write.statements[0].kind, "error", "server read-only transaction must block stored function writes");
    let note: Option<String> = conn.query_first(format!("SELECT note FROM `{database}`.t")).await.unwrap();
    assert_eq!(note.as_deref(), Some("original"));
    state.profiles.lock().unwrap()[0].read_only = false;
    let write = query::execute(&state, payload(&id, &database, "UPDATE t SET note='allowed' WHERE id=1")).await.unwrap();
    assert_eq!(write.statements[0].kind, "command");
    conn.query_drop(format!("DROP DATABASE `{database}`")).await.unwrap();
}

#[tokio::test]
async fn composite_primary_key_sync_keeps_duplicates_across_page_boundaries() {
    let Some((state, session)) = context().await else { return };
    let source_db = format!("finch_source_{}", uuid::Uuid::new_v4().simple());
    let target_db = format!("finch_target_{}", uuid::Uuid::new_v4().simple());
    let mut conn = session.pool.get_conn().await.unwrap();
    for database in [&source_db, &target_db] { conn.query_drop(format!("CREATE DATABASE `{database}`")).await.unwrap(); }
    conn.query_drop("SET SESSION cte_max_recursion_depth=3000").await.unwrap();
    // 1300 duplicates of each numeric component (1 and 6000), exceeding the old page size 500.
    for (table, key_type, key_expr) in [("pair_int", "INT", "n"), ("pair_string", "VARCHAR(32)", "CONCAT('key-',n)")] {
        conn.query_drop(format!("CREATE TABLE `{source_db}`.`{table}` (a INT, b {key_type}, note VARCHAR(32), PRIMARY KEY (a,b))")).await.unwrap();
        conn.query_drop(format!("INSERT INTO `{source_db}`.`{table}` WITH RECURSIVE seq AS (SELECT 1 n UNION ALL SELECT n+1 FROM seq WHERE n<2600) SELECT IF(n<=1300,1,6000), {key_expr}, CONCAT('row-',n) FROM seq")).await.unwrap();
    }
    for mode in ["append", "upsert", "replace"] {
        let result = sync::run(None, &state, SyncRequest {
            source_id:session.id.clone(), target_id:session.id.clone(),
            source_database:source_db.clone(), target_database:target_db.clone(),
            tables:["pair_int", "pair_string"].iter().map(|name| SyncTable { name:(*name).into(), mode:mode.into(), columns:vec![] }).collect(),
            create_missing:true, batch_size:Some(50), concurrency:Some(4),
        }).await.unwrap();
        for table in result.tables {
            assert!(table.error.is_none(), "{:?}", table.error);
            assert_eq!(table.read, 2600);
            assert_eq!(table.written, 2600);
            let missing: Option<u64> = conn.query_first(format!("SELECT COUNT(*) FROM `{source_db}`.`{0}` s LEFT JOIN `{target_db}`.`{0}` t ON s.a=t.a AND s.b=t.b AND s.note=t.note WHERE t.a IS NULL", table.table)).await.unwrap();
            assert_eq!(missing, Some(0));
            let total: Option<u64> = conn.query_first(format!("SELECT COUNT(*) FROM `{target_db}`.`{}`", table.table)).await.unwrap();
            assert_eq!(total, Some(2600));
        }
    }
    for database in [&source_db, &target_db] { conn.query_drop(format!("DROP DATABASE `{database}`")).await.unwrap(); }
}

#[tokio::test]
async fn heartbeat_honors_interval_errors_and_reconnect_toggle() {
    let Some((state, session)) = context().await else { return };
    let now = Instant::now();
    *session.last_heartbeat.lock().unwrap() = now;
    let mut profile = state.profile(&session.id).unwrap();
    assert!(!heartbeat::claim_due(&session, &profile, now + Duration::from_secs(30)));
    assert!(heartbeat::claim_due(&session, &profile, now + Duration::from_secs(60)));
    assert!(!heartbeat::claim_due(&session, &profile, now + Duration::from_secs(120)), "no overlapping heartbeat");
    session.heartbeat_running.store(false, Ordering::Relaxed);
    profile.keep_alive_seconds = 10;
    assert!(heartbeat::claim_due(&session, &profile, now + Duration::from_secs(70)));
    session.heartbeat_running.store(false, Ordering::Relaxed);
    let mut borrowed = Vec::new();
    for _ in 0..8 { borrowed.push(session.pool.get_conn().await.unwrap()); }
    assert!(!heartbeat::claim_due(&session, &profile, now + Duration::from_secs(80)), "saturated pool must not trigger a reconnect");
    drop(borrowed);

    state.profiles.lock().unwrap()[0].auto_reconnect = false;
    let events = heartbeat::finish_check(&state, &session, Err("ping returned error".into())).await;
    assert_eq!(events[0]["status"], "error");
    assert!(Arc::ptr_eq(&state.session(&session.id).unwrap(), &session));
    assert!(db::reconnect_state(&state, &session.id).await.err().unwrap().contains("自动重连已关闭"));
    profile.auto_reconnect = false;
    assert!(!heartbeat::claim_due(&session, &profile, now + Duration::from_secs(180)));

    state.profiles.lock().unwrap()[0].auto_reconnect = true;
    let events = heartbeat::finish_check(&state, &session, Err("ping timeout".into())).await;
    assert_eq!(events[0]["reconnected"], true);
    let replacement = state.session(&session.id).unwrap();
    assert!(!Arc::ptr_eq(&replacement, &session));
    assert!(heartbeat::finish_check(&state, &session, Err("stale error".into())).await.is_empty());
    state.profiles.lock().unwrap()[0].auto_reconnect = false;
    replacement.pool.clone().disconnect().await.unwrap();
    assert!(query::execute(&state, payload(&session.id, "finch_demo", "SELECT 1")).await.is_err());
    assert!(Arc::ptr_eq(&state.session(&session.id).unwrap(), &replacement), "query path must also honor disabled reconnect");
    state.sessions.lock().unwrap().remove(&session.id);
    assert!(heartbeat::finish_check(&state, &replacement, Err("disconnected".into())).await.is_empty());
    assert!(state.session(&session.id).is_err());
}
