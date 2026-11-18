mod ai;
mod ai_stream;
mod commands;
mod db;
mod ddl;
mod dump;
mod heartbeat;
mod lan;
mod models;
mod query;
mod schema;
mod ssh;
mod sql;
mod sync;
mod store;

#[cfg(test)]
mod regression_tests;

use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(db::AppState::new())
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                    let state = handle.state::<db::AppState>();
                    let sessions: Vec<_> = state
                        .sessions
                        .lock()
                        .unwrap()
                        .values()
                        .cloned()
                        .collect();
                    for session in sessions {
                        let Ok(profile) = state.profile(&session.id) else { continue };
                        if !heartbeat::claim_due(&session, &profile, std::time::Instant::now()) { continue; }
                        let handle = handle.clone();
                        tauri::async_runtime::spawn(async move {
                            let state = handle.state::<db::AppState>();
                            for event in heartbeat::check(&state, &session).await {
                                let _ = tauri::Emitter::emit(&handle, "finch://event", event);
                            }
                            session.heartbeat_running.store(false, std::sync::atomic::Ordering::Relaxed);
                        });
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::list_connections,
            commands::save_connection,
            commands::delete_connection,
            commands::test_connection,
            commands::connect,
            commands::disconnect,
            commands::ping,
            commands::list_databases,
            commands::list_tables,
            commands::list_columns,
            commands::get_table_details,
            commands::list_routines,
            commands::execute_query,
            commands::cancel_query,
            commands::explain_query,
            commands::get_table_data,
            commands::count_table_rows,
            commands::list_all_columns,
            commands::update_cell,
            commands::update_cells,
            commands::delete_rows,
            commands::insert_row,
            commands::server_overview,
            commands::server_processes,
            commands::kill_process,
            commands::server_variables,
            commands::list_history,
            commands::clear_history,
            commands::delete_history,
            commands::list_snippets,
            commands::save_snippet,
            commands::delete_snippet,
            commands::get_settings,
            commands::set_settings,
            commands::set_theme,
            commands::set_title,
            commands::set_webview_zoom,
            commands::lan_start,
            commands::lan_stop,
            commands::lan_status,
            commands::lan_set_device_name,
            commands::lan_connect,
            commands::lan_respond,
            commands::lan_send_file,
            commands::lan_send_tables,
            commands::lan_disconnect,
            commands::write_text_file,
            commands::read_text_file,
            commands::reveal_path,
            commands::list_ai_providers,
            commands::save_ai_provider,
            commands::delete_ai_provider,
            commands::generate_sql,
            commands::cancel_ai,
            commands::sync_preview,
            commands::run_sync,
            commands::create_table,
            commands::alter_table,
            commands::drop_table,
            commands::dump_database,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Finch");
}

#[cfg(test)]
mod backend_tests {
    use mysql_async::prelude::Queryable;

    use super::*;
    use crate::db::AppState;
    use crate::models::*;

    fn profile() -> ConnectionProfile {
        ConnectionProfile {
            id: "rust-test-demo".into(),
            name: "Rust test demo".into(),
            category: "local".into(),
            host: "127.0.0.1".into(),
            port: 3407,
            user: "root".into(),
            database: "finch_demo".into(),
            keep_alive_seconds: 30,
            auto_reconnect: true,
            connect_timeout: 5000,
            ..Default::default()
        }
    }

    fn payload(sql: &str, database: &str) -> QueryPayload {
        QueryPayload {
            session_id: "rust-test-demo".into(),
            sql: sql.into(),
            database: database.into(),
            execution_id: uuid::Uuid::new_v4().to_string(),
            max_rows: Some(100),
            auto_limit: Some(false),
            timeout_ms: None,
            prod_confirmed: true,
        }
    }

    #[test]
    fn sql_splitter_handles_quotes_and_comments() {
        let sql = "SELECT 1; SELECT 'a;b'; -- comment;\nSELECT \"c;d\" FROM t;";
        let parts = db::split_statements(sql);
        assert_eq!(parts.len(), 3, "{parts:?}");
        assert_eq!(parts[0], "SELECT 1");
        assert!(parts[1].contains("'a;b'"));
        assert!(parts[2].contains("FROM t"));
    }


    async fn demo_state() -> Option<(std::sync::Arc<AppState>, ConnectionProfile)> {
        let profile = profile();
        let session = match db::open_session(&profile, "").await {
            Ok(session) => session,
            Err(err) => {
                assert!(std::env::var_os("FINCH_REQUIRE_MYSQL_TESTS").is_none(), "demo MySQL is required: {err}");
                eprintln!("skipping mysql integration test: {err}");
                return None;
            }
        };
        let state = std::sync::Arc::new(AppState::new());
        {
            *state.profiles.lock().unwrap() = vec![profile.clone()];
            state.sessions.lock().unwrap().insert(profile.id.clone(), session);
        }
        Some((state, profile))
    }

    fn query_payload(profile: &ConnectionProfile, sql: &str, execution_id: &str) -> QueryPayload {
        QueryPayload {
            session_id: profile.id.clone(),
            sql: sql.into(),
            database: "finch_demo".into(),
            execution_id: execution_id.into(),
            max_rows: Some(5000),
            auto_limit: Some(true),
            timeout_ms: None,
            prod_confirmed: true,
        }
    }

    #[tokio::test]
    async fn server_side_timeout_aborts_runaway_query() {
        let Some((state, profile)) = demo_state().await else { return };
        let started = std::time::Instant::now();
        let mut payload = query_payload(&profile, "SELECT COUNT(*) FROM information_schema.COLUMNS c1, information_schema.COLUMNS c2, information_schema.COLUMNS c3, information_schema.COLUMNS c4", "timeout-test");
        payload.timeout_ms = Some(700);
        let result = query::execute(&state, payload).await.expect("query result");
        let elapsed = started.elapsed();
        assert!(elapsed < std::time::Duration::from_secs(10), "timeout took {elapsed:?}");
        let statement = &result.statements[0];
        let failed = statement.kind == "error";
        if failed {
            let message = statement.error.as_ref().map(|e| e.message.clone()).unwrap_or_default();
            assert!(message.contains("时间上限") || message.contains("3024"), "{message}");
        }
        assert!(elapsed < std::time::Duration::from_secs(10));
    }

    #[tokio::test]
    async fn cancel_interrupts_a_running_query() {
        let Some((state, profile)) = demo_state().await else { return };
        let execution_id = "cancel-test-execution";
        let payload = query_payload(&profile, "SELECT SLEEP(30)", execution_id);
        let state_for_query = state.clone();
        let handle = tokio::spawn(async move { query::execute(&state_for_query, payload).await });

        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        let started = std::time::Instant::now();
        let accepted = query::cancel(&state, execution_id, &profile.id).await.unwrap();
        assert!(accepted, "cancel should find the running execution");

        let result = tokio::time::timeout(std::time::Duration::from_secs(8), handle)
            .await
            .expect("KILL QUERY should interrupt SLEEP(30) quickly")
            .expect("query task panicked")
            .expect("query task failed");
        assert!(result.cancelled, "result should be flagged as cancelled");
        assert!(
            started.elapsed() < std::time::Duration::from_secs(8),
            "cancel took too long: {:?}",
            started.elapsed()
        );
    }

    #[tokio::test]
    async fn allocation_join_returns_31_rows_and_matches_direct_mysql() {
        let Some((state, profile)) = demo_state().await else { return };
        let database = format!("finch_perf_{}", uuid::Uuid::new_v4().simple());
        let session = state.session(&profile.id).unwrap();
        let mut conn = session.pool.get_conn().await.unwrap();
        conn.query_drop(format!("CREATE DATABASE `{database}` CHARACTER SET utf8mb4")).await.unwrap();
        let outcome = async {
            conn.query_drop(format!("USE `{database}`")).await.unwrap();
            for sql in db::split_statements(include_str!("../tests/fixtures/allocation-schema.sql")) {
                conn.query_drop(sql).await.unwrap();
            }
            let sql = include_str!("../tests/fixtures/allocation-query.sql");
            let mut direct_ms = Vec::new();
            let mut finch_ms = Vec::new();
            for index in 0..5 {
                let started = std::time::Instant::now();
                let direct = conn.query::<mysql_async::Row, _>(sql).await.unwrap();
                direct_ms.push(started.elapsed().as_secs_f64() * 1000.0);
                assert_eq!(direct.len(), 31);
                let mut payload = query_payload(&profile, sql, &format!("join-{index}"));
                payload.database = database.clone();
                let started = std::time::Instant::now();
                let result = query::execute(&state, payload).await.unwrap();
                finch_ms.push(started.elapsed().as_secs_f64() * 1000.0);
                assert_eq!(result.statements.len(), 1);
                let statement = &result.statements[0];
                assert_eq!(statement.kind, "rows", "{:?}", statement.error);
                assert_eq!(statement.row_count, 31);
                assert_eq!(statement.columns.len(), 11);
                assert_eq!(statement.rows[0][6], serde_json::json!("自动调拨"));
                assert!(!statement.truncated);
                assert!(finch_ms[index] < 2000.0, "31-row JOIN took {} ms", finch_ms[index]);
                let serialized_at = std::time::Instant::now();
                let encoded = serde_json::to_vec(&result).unwrap();
                eprintln!("join round={index}: direct={:.3} ms, finch={:.3} ms, IPC JSON={} bytes, serialize={:.3} ms, stages={:?}", direct_ms[index], finch_ms[index], encoded.len(), serialized_at.elapsed().as_secs_f64()*1000.0, result.timings);
            }
            direct_ms.sort_by(f64::total_cmp);
            finch_ms.sort_by(f64::total_cmp);
            eprintln!("JOIN_BENCHMARK rows=31 source_rows=100000 joins=8 direct_median_ms={:.3} finch_median_ms={:.3}", direct_ms[2], finch_ms[2]);
        }.await;
        conn.query_drop(format!("DROP DATABASE `{database}`")).await.unwrap();
        outcome
    }

    #[tokio::test]
    async fn client_deadline_interrupts_sleep_and_releases_registration() {
        let Some((state, profile)) = demo_state().await else { return };
        // SLEEP is not reliably interrupted by MySQL max_execution_time.
        let mut payload = query_payload(&profile, "SELECT SLEEP(30)", "client-deadline");
        payload.timeout_ms = Some(150);
        let started = std::time::Instant::now();
        let result = query::execute(&state, payload).await.unwrap();
        assert!(started.elapsed() < std::time::Duration::from_secs(2));
        assert_eq!(result.statements[0].kind, "error");
        assert!(state.cancels.lock().unwrap().is_empty());
        let result = query::execute(&state, query_payload(&profile, "SELECT 42", "after-timeout")).await.unwrap();
        assert_eq!(result.statements[0].rows[0][0], serde_json::json!(42));
    }

    #[tokio::test]
    async fn queued_query_can_cancel_without_killing_pool_borrowers() {
        let Some((state, profile)) = demo_state().await else { return };
        let session = state.session(&profile.id).unwrap();
        let mut borrowed = Vec::new();
        for _ in 0..8 { borrowed.push(session.pool.get_conn().await.unwrap()); }
        let state_for_query = state.clone();
        let payload = query_payload(&profile, "SELECT 1", "queued-cancel");
        let query = tokio::spawn(async move { query::execute(&state_for_query, payload).await });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert!(query::cancel(&state, "queued-cancel", &profile.id).await.unwrap());
        let result = tokio::time::timeout(std::time::Duration::from_secs(1), query).await.unwrap().unwrap().unwrap();
        assert!(result.cancelled);
        assert!(state.cancels.lock().unwrap().is_empty());
        for conn in &mut borrowed { conn.ping().await.unwrap(); }
    }

    #[tokio::test]
    async fn failed_session_setup_does_not_leak_execution() {
        let Some((state, profile)) = demo_state().await else { return };
        let mut payload = query_payload(&profile, "SELECT 1", "bad-database");
        payload.database = "finch_database_that_does_not_exist".into();
        assert!(query::execute(&state, payload).await.is_err());
        assert!(state.cancels.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn large_result_payload_is_capped() {
        let Some((state, profile)) = demo_state().await else { return };
        let session = state.session(&profile.id).unwrap();
        let mut conn = session.pool.get_conn().await.unwrap();
        conn.query_drop("DROP TABLE IF EXISTS finch_demo.finch_big_text").await.unwrap();
        conn.query_drop(
            "CREATE TABLE finch_demo.finch_big_text (id INT NOT NULL PRIMARY KEY, body LONGTEXT)",
        )
        .await
        .unwrap();
        conn.query_drop("SET SESSION cte_max_recursion_depth = 2000").await.unwrap();
        conn.query_drop(
            "INSERT INTO finch_demo.finch_big_text (id, body) \
             WITH RECURSIVE seq AS (SELECT 1 AS n UNION ALL SELECT n + 1 FROM seq WHERE n < 400) \
             SELECT n, REPEAT('x', 20000) FROM seq",
        )
        .await
        .unwrap();
        drop(conn);

        let started = std::time::Instant::now();
        let result = query::execute(
            &state,
            query_payload(&profile, "SELECT * FROM finch_big_text", "bytes-test"),
        )
        .await
        .expect("query");
        let statement = &result.statements[0];
        assert!(statement.truncated, "payload should be truncated");
        assert_eq!(statement.truncated_reason.as_deref(), Some("bytes"));
        assert!(statement.rows.len() < 400, "kept {} rows", statement.rows.len());
        assert!(
            started.elapsed() < std::time::Duration::from_secs(15),
            "capped query should return quickly, took {:?}",
            started.elapsed()
        );

        let session = state.session(&profile.id).unwrap();
        let mut conn = session.pool.get_conn().await.unwrap();
        conn.query_drop("DROP TABLE finch_demo.finch_big_text").await.unwrap();
    }

    #[tokio::test]
    async fn mysql_query_sync_ddl_dump() {
        let profile = profile();
        let session = match db::open_session(&profile, "").await {
            Ok(session) => session,
            Err(err) => {
                eprintln!("skipping mysql integration test: {err}");
                return;
            }
        };
        let state = AppState::new();
        {
            *state.profiles.lock().unwrap() = vec![profile.clone()];
            state.sessions.lock().unwrap().insert(profile.id.clone(), session.clone());
        }

        let result = query::execute(&state, payload("SELECT 42 AS answer", "finch_demo"))
            .await
            .expect("query");
        assert_eq!(result.statements[0].rows[0][0], serde_json::json!(42));

        let filtered = schema::get_table_data(
            &state,
            TableDataPayload {
                session_id: profile.id.clone(),
                database: "finch_demo".into(),
                table: "orders".into(),
                limit: 200,
                offset: 0,
                filters: vec![TableFilter {
                    column: "status".into(),
                    op: "CONTAINS".into(),
                    value: "ship".into(),
                    value2: None,
                }],
                search: String::new(),
                order_by: None,
                order_dir: "asc".into(),
            },
        )
        .await
        .expect("contains filter");
        let status_index = filtered.columns.iter().position(|column| column.name == "status").unwrap();
        assert!(filtered.rows.iter().all(|row| row[status_index].as_str().unwrap_or("").contains("ship")));

        let ranged = schema::get_table_data(
            &state,
            TableDataPayload {
                session_id: profile.id.clone(),
                database: "finch_demo".into(),
                table: "orders".into(),
                limit: 200,
                offset: 0,
                filters: vec![TableFilter {
                    column: "id".into(),
                    op: "BETWEEN".into(),
                    value: "1".into(),
                    value2: Some("10".into()),
                }],
                search: String::new(),
                order_by: None,
                order_dir: "asc".into(),
            },
        )
        .await
        .expect("between filter");
        let ranged_total = schema::count_rows(
            &state,
            TableDataPayload {
                session_id: profile.id.clone(),
                database: "finch_demo".into(),
                table: "orders".into(),
                limit: 200,
                offset: 0,
                filters: vec![TableFilter {
                    column: "id".into(),
                    op: "BETWEEN".into(),
                    value: "1".into(),
                    value2: Some("10".into()),
                }],
                search: String::new(),
                order_by: None,
                order_dir: "asc".into(),
            },
        )
        .await
        .expect("count");
        assert_eq!(ranged_total, Some(10));
        assert_eq!(ranged.total, None, "row count is fetched separately");
        let all = schema::all_columns(&state, &profile.id, "finch_demo")
            .await
            .expect("all columns");
        assert!(all.get("orders").map(|cols| !cols.is_empty()).unwrap_or(false));

        let mut conn = session.pool.get_conn().await.expect("conn");
        conn.query_drop("DROP DATABASE IF EXISTS finch_sync_test").await.unwrap();
        conn.query_drop("CREATE DATABASE finch_sync_test").await.unwrap();

        let sync = sync::run(
            None,
            &state,
            SyncRequest {
                source_id: profile.id.clone(),
                target_id: profile.id.clone(),
                source_database: "finch_demo".into(),
                target_database: "finch_sync_test".into(),
                tables: vec![SyncTable {
                    name: "customers".into(),
                    mode: "upsert".into(),
                    columns: vec![],
                }],
                create_missing: true,
                batch_size: Some(100),
                concurrency: Some(1),
            },
        )
        .await
        .expect("sync");
        assert_eq!(sync.tables[0].written, 220);
        assert!(sync.created_tables.contains(&"customers".to_string()));

        // Existing target DDL must not be altered by a second sync.
        conn.query_drop("ALTER TABLE finch_sync_test.customers ADD COLUMN local_only VARCHAR(20) NULL")
            .await
            .unwrap();
        conn.query_drop("UPDATE finch_demo.customers SET city='SyncCity' WHERE id=1")
            .await
            .unwrap();
        let sync2 = sync::run(
            None,
            &state,
            SyncRequest {
                source_id: profile.id.clone(),
                target_id: profile.id.clone(),
                source_database: "finch_demo".into(),
                target_database: "finch_sync_test".into(),
                tables: vec![SyncTable {
                    name: "customers".into(),
                    mode: "upsert".into(),
                    columns: vec![],
                }],
                create_missing: false,
                batch_size: Some(100),
                concurrency: Some(2),
            },
        )
        .await
        .expect("sync2");
        assert!(sync2.tables[0].error.is_none());
        let row = conn
            .query_first::<mysql_async::Row, _>(
                "SELECT city, local_only FROM finch_sync_test.customers WHERE id=1",
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(crate::db::mysql_to_text(row.as_ref(0)), "SyncCity");
        assert_eq!(row.as_ref(1), Some(&mysql_async::Value::NULL));
        conn.query_drop("UPDATE finch_demo.customers SET city='Paris' WHERE id=1")
            .await
            .unwrap();

        conn.query_drop("DROP TABLE IF EXISTS finch_demo.finch_shard_src").await.unwrap();
        conn.query_drop(
            "CREATE TABLE finch_demo.finch_shard_src (id BIGINT NOT NULL PRIMARY KEY, value VARCHAR(32))",
        )
        .await
        .unwrap();
        conn.query_drop("SET SESSION cte_max_recursion_depth = 10000").await.unwrap();
        conn.query_drop(
            "INSERT INTO finch_demo.finch_shard_src (id, value) \
             WITH RECURSIVE seq AS (SELECT 1 AS n UNION ALL SELECT n + 1 FROM seq WHERE n < 6000) \
             SELECT n, CONCAT('v', n) FROM seq",
        )
        .await
        .unwrap();
        let shard_sync = sync::run(
            None,
            &state,
            SyncRequest {
                source_id: profile.id.clone(),
                target_id: profile.id.clone(),
                source_database: "finch_demo".into(),
                target_database: "finch_sync_test".into(),
                tables: vec![SyncTable {
                    name: "finch_shard_src".into(),
                    mode: "upsert".into(),
                    columns: vec![],
                }],
                create_missing: true,
                batch_size: Some(500),
                concurrency: Some(4),
            },
        )
        .await
        .expect("sharded sync");
        assert_eq!(shard_sync.tables[0].written, 6000);
        assert!(shard_sync.tables[0].shards > 1, "expected numeric primary-key shards");
        let shard_count = conn
            .query_first::<u64, _>("SELECT COUNT(*) FROM finch_sync_test.finch_shard_src")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(shard_count, 6000);
        conn.query_drop("DROP TABLE finch_demo.finch_shard_src").await.unwrap();

        let ddl = ddl::create_table(
            &state,
            CreateTableRequest {
                session_id: profile.id.clone(),
                database: "finch_sync_test".into(),
                table: "finch_ddl_test".into(),
                columns: vec![DdlColumn {
                    name: "id".into(),
                    column_type: "BIGINT".into(),
                    nullable: false,
                    auto_increment: true,
                    primary: true,
                    ..Default::default()
                }],
                engine: "InnoDB".into(),
                charset: "utf8mb4".into(),
                indexes: vec![DdlIndex {
                    name: "".into(),
                    columns: vec!["id".into()],
                    unique: false,
                    index_type: "BTREE".into(),
                }],
            },
        )
        .await
        .expect("create");
        assert!(ddl.contains("CREATE TABLE"));
        assert!(ddl.contains("KEY `idx_id`"), "{ddl}");
        ddl::alter_table(
            &state,
            AlterTableRequest {
                session_id: profile.id.clone(),
                database: "finch_sync_test".into(),
                table: "finch_ddl_test".into(),
                add: vec![DdlColumn {
                    name: "note".into(),
                    column_type: "VARCHAR(100)".into(),
                    nullable: true,
                    ..Default::default()
                }],
                add_indexes: vec![DdlIndex {
                    name: "uniq_note".into(),
                    columns: vec!["note".into()],
                    unique: true,
                    index_type: "BTREE".into(),
                }],
                ..Default::default()
            },
        )
        .await
        .expect("alter");
        let mut index_names: Vec<String> = conn
            .query::<mysql_async::Row, _>("SHOW INDEX FROM finch_sync_test.finch_ddl_test")
            .await
            .unwrap()
            .into_iter()
            .map(|row| crate::db::mysql_to_text(row.as_ref(2)))
            .collect();
        index_names.sort();
        index_names.dedup();
        assert!(index_names.iter().any(|name| name == "uniq_note"), "{index_names:?}");
        assert!(index_names.iter().any(|name| name == "idx_id"), "{index_names:?}");

        ddl::alter_table(
            &state,
            AlterTableRequest {
                session_id: profile.id.clone(),
                database: "finch_sync_test".into(),
                table: "finch_ddl_test".into(),
                drop_indexes: vec!["idx_id".into()],
                modify_indexes: vec![DdlIndex {
                    name: "uniq_note".into(),
                    columns: vec!["note".into(), "id".into()],
                    unique: true,
                    index_type: "BTREE".into(),
                }],
                ..Default::default()
            },
        )
        .await
        .expect("alter indexes");
        let remaining: Vec<String> = conn
            .query::<mysql_async::Row, _>("SHOW INDEX FROM finch_sync_test.finch_ddl_test")
            .await
            .unwrap()
            .into_iter()
            .map(|row| crate::db::mysql_to_text(row.as_ref(2)))
            .collect();
        assert!(!remaining.iter().any(|name| name == "idx_id"), "{remaining:?}");
        assert!(remaining.iter().any(|name| name == "uniq_note"));

        let bad_index = ddl::create_table(
            &state,
            CreateTableRequest {
                session_id: profile.id.clone(),
                database: "finch_sync_test".into(),
                table: "finch_bad_index".into(),
                columns: vec![DdlColumn {
                    name: "id".into(),
                    column_type: "BIGINT".into(),
                    ..Default::default()
                }],
                engine: "InnoDB".into(),
                charset: "utf8mb4".into(),
                indexes: vec![DdlIndex {
                    name: "idx_missing".into(),
                    columns: vec!["missing_column".into()],
                    unique: false,
                    index_type: "BTREE".into(),
                }],
            },
        )
        .await;
        assert!(bad_index.is_err());
        ddl::drop_table(&state, &profile.id, "finch_sync_test", "finch_ddl_test")
            .await
            .expect("drop");

        let dump_path = "/tmp/finch-rust-test-dump.sql";
        dump::dump(
            None,
            &state,
            DumpRequest {
                session_id: profile.id.clone(),
                database: "finch_demo".into(),
                path: dump_path.into(),
                structure: true,
                data: true,
                tables: vec!["customers".into()],
                split_files: false,
            },
        )
        .await
        .expect("dump");
        let dump_text = std::fs::read_to_string(dump_path).unwrap();
        assert!(dump_text.contains("CREATE TABLE"));
        assert!(dump_text.contains("INSERT INTO"));
        let _ = std::fs::remove_file(dump_path);

        let split_dir = "/tmp/finch-rust-test-split";
        let _ = std::fs::remove_dir_all(split_dir);
        let split = dump::dump(
            None,
            &state,
            DumpRequest {
                session_id: profile.id.clone(),
                database: "finch_demo".into(),
                path: split_dir.into(),
                structure: true,
                data: false,
                tables: vec!["customers".into(), "orders".into()],
                split_files: true,
            },
        )
        .await
        .expect("split dump");
        assert_eq!(split["files"].as_array().unwrap().len(), 2);
        let customers = std::fs::read_to_string(format!("{split_dir}/customers.sql")).unwrap();
        assert!(customers.contains("Table structure for `customers`"));
        assert!(!customers.contains("Table structure for `orders`"));
        let _ = std::fs::remove_dir_all(split_dir);
        conn.query_drop("DROP DATABASE IF EXISTS finch_sync_test").await.unwrap();
    }
}
