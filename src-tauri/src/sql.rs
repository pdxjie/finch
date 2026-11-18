//! Client-side SQL scanning. All offsets are bytes at ASCII syntax boundaries;
//! never slice a UTF-8 string at a fixed character count.

fn line_comment(bytes: &[u8], at: usize) -> bool {
    bytes[at] == b'#'
        || (bytes[at..].starts_with(b"--")
            && bytes.get(at + 2).map_or(true, u8::is_ascii_whitespace))
}

fn quoted_end(bytes: &[u8], mut at: usize) -> usize {
    let quote = bytes[at];
    at += 1;
    while at < bytes.len() {
        if bytes[at] == b'\\' && quote != b'`' {
            at = (at + 2).min(bytes.len());
        } else if bytes[at] == quote {
            if bytes.get(at + 1) == Some(&quote) {
                at += 2;
            } else {
                return at + 1;
            }
        } else {
            at += 1;
        }
    }
    at
}

fn comment_end(bytes: &[u8], at: usize) -> Option<usize> {
    if line_comment(bytes, at) {
        Some(at + bytes[at..].iter().position(|b| *b == b'\n').unwrap_or(bytes.len() - at))
    } else if bytes[at..].starts_with(b"/*") {
        Some(bytes[at + 2..].windows(2).position(|w| w == b"*/")
            .map_or(bytes.len(), |end| at + 2 + end + 2))
    } else {
        None
    }
}

fn skip_trivia(sql: &str) -> usize {
    let bytes = sql.as_bytes();
    let mut at = if sql.starts_with('\u{feff}') { 3 } else { 0 };
    while at < bytes.len() {
        if bytes[at].is_ascii_whitespace() {
            at += 1;
        } else if bytes[at..].starts_with(b"/*!") {
            break; // Executable MySQL version comments are SQL, not whitespace.
        } else if let Some(end) = comment_end(bytes, at) {
            at = end;
        } else {
            break;
        }
    }
    at
}

pub fn first_keyword(sql: &str) -> String {
    let at = skip_trivia(sql);
    let end = sql.as_bytes()[at..].iter().position(|b| !b.is_ascii_alphabetic())
        .map_or(sql.len(), |end| at + end);
    sql[at..end].to_ascii_uppercase()
}

/// Conservative read-only gate. Ignore quoted values/identifiers and ordinary
/// comments, but reject executable comments rather than letting them hide SQL.
pub fn validate_read_only(sql: &str) -> Result<(), String> {
    let first = first_keyword(sql);
    if !matches!(first.as_str(),
        "SELECT" | "SHOW" | "DESCRIBE" | "DESC" | "EXPLAIN" | "WITH" | "TABLE" | "VALUES") {
        return Err("只读连接只允许查询和查看执行计划".into());
    }
    let bytes = sql.as_bytes();
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at..].starts_with(b"/*!") || bytes[at..].starts_with(b"/*M!") {
            return Err("只读连接不允许可执行注释".into());
        } else if matches!(bytes[at], b'\'' | b'"' | b'`') {
            at = quoted_end(bytes, at);
        } else if let Some(end) = comment_end(bytes, at) {
            at = end;
        } else if bytes[at].is_ascii_alphabetic() || bytes[at] == b'_' {
            let start = at;
            while at < bytes.len() && (bytes[at].is_ascii_alphanumeric() || matches!(bytes[at], b'_' | b'$') || bytes[at] >= 128) {
                at += 1;
            }
            let word = sql[start..at].to_ascii_uppercase();
            if first == "SHOW" && word == "CREATE" { continue; }
            if matches!(word.as_str(), "INSERT" | "UPDATE" | "DELETE" | "REPLACE" |
                "ALTER" | "DROP" | "CREATE" | "TRUNCATE" | "RENAME" | "GRANT" |
                "REVOKE" | "LOAD" | "CALL" | "INTO" | "SET" | "COMMIT" | "ROLLBACK" |
                "GET_LOCK" | "RELEASE_LOCK" | "RELEASE_ALL_LOCKS") {
                return Err(format!("只读连接已阻止操作: {word}"));
            }
        } else {
            at += 1;
        }
    }
    Ok(())
}

pub fn has_dangerous_sql(sql: &str) -> bool {
    let bytes = sql.as_bytes();
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at..].starts_with(b"/*!") || bytes[at..].starts_with(b"/*M!") {
            return true;
        } else if matches!(bytes[at], b'\'' | b'"' | b'`') {
            at = quoted_end(bytes, at);
        } else if let Some(end) = comment_end(bytes, at) {
            at = end;
        } else if bytes[at].is_ascii_alphabetic() || bytes[at] == b'_' {
            let start = at;
            while at < bytes.len()
                && (bytes[at].is_ascii_alphanumeric() || matches!(bytes[at], b'_' | b'$') || bytes[at] >= 128)
            {
                at += 1;
            }
            let word = sql[start..at].to_ascii_uppercase();
            if matches!(
                word.as_str(),
                "INSERT" | "UPDATE" | "DELETE" | "DROP" | "ALTER" | "TRUNCATE" | "RENAME" | "REPLACE" | "CREATE" | "LOAD" | "GRANT" | "REVOKE"
            ) {
                return true;
            }
        } else {
            at += 1;
        }
    }
    false
}

pub fn split_statements(input: &str) -> Vec<String> {
    let bytes = input.as_bytes();
    let mut statements = Vec::new();
    let mut delimiter = ";";
    let mut start = 0;
    let mut at = 0;
    let mut line_start = true;
    while at < bytes.len() {
        if line_start {
            let mut word = at;
            while bytes.get(word).is_some_and(|b| matches!(b, b' ' | b'\t' | b'\r')) {
                word += 1;
            }
            if bytes.get(word..word + 9).is_some_and(|s| s.eq_ignore_ascii_case(b"DELIMITER"))
                && bytes.get(word + 9).is_some_and(u8::is_ascii_whitespace)
                && skip_trivia(&input[start..at]) == at - start
            {
                let end = word + bytes[word..].iter().position(|b| *b == b'\n').unwrap_or(bytes.len() - word);
                if let Some(value) = input[word + 9..end].split_whitespace().next() {
                    delimiter = value;
                }
                at = end;
                start = at;
                line_start = false;
                continue;
            }
        }
        if bytes[at..].starts_with(delimiter.as_bytes()) {
            let sql = input[start..at].trim();
            if skip_trivia(sql) < sql.len() {
                statements.push(sql.to_string());
            }
            at += delimiter.len();
            start = at;
            line_start = false;
        } else if matches!(bytes[at], b'\'' | b'"' | b'`') {
            at = quoted_end(bytes, at);
            line_start = false;
        } else if let Some(end) = comment_end(bytes, at) {
            at = end;
            line_start = false;
        } else {
            line_start = bytes[at] == b'\n';
            at += 1;
        }
    }
    let sql = input[start..].trim();
    if skip_trivia(sql) < sql.len() {
        statements.push(sql.to_string());
    }
    statements
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dangerous_sql_detection_covers_cte_and_ignores_literals() {
        assert!(has_dangerous_sql("UPDATE t SET a=1"));
        assert!(has_dangerous_sql("WITH x AS (SELECT 1) DELETE FROM t"));
        assert!(has_dangerous_sql("DROP TABLE t"));
        assert!(has_dangerous_sql("/*!50000 DROP TABLE t */"));
        assert!(!has_dangerous_sql("SELECT 'DELETE', `update` FROM t"));
        assert!(!has_dangerous_sql("-- DELETE FROM t\nSELECT 1"));
    }

    #[test]
    fn read_only_gate_covers_cte_and_executable_comments() {
        for sql in ["SELECT 1", "SHOW TABLES", "SHOW CREATE TABLE t", "WITH x AS (SELECT 1) SELECT * FROM x",
            "SELECT 'UPDATE 中文', `delete` FROM t /* DROP */", "EXPLAIN SELECT 1"] {
            assert!(validate_read_only(sql).is_ok(), "{sql}");
        }
        for sql in ["SET autocommit=0", "CALL p()", "WITH x AS (SELECT 1) UPDATE t SET a=1",
            "SELECT 1 INTO OUTFILE '/tmp/test'", "SELECT 1 /*!50000 INTO OUTFILE '/tmp/test' */",
            "/*!50000 DELETE FROM t */", "EXPLAIN ANALYZE DELETE FROM t", "SELECT GET_LOCK('x', 1)"] {
            assert!(validate_read_only(sql).is_err(), "{sql}");
        }
    }

    #[test]
    fn chinese_case_and_join_query_does_not_panic() {
        let sql = include_str!("../tests/fixtures/allocation-query.sql");
        let statements = split_statements(sql);
        assert_eq!(statements, vec![sql.trim().trim_end_matches(';')]);
        assert_eq!(first_keyword(&statements[0]), "SELECT");
    }

    #[test]
    fn preserves_quotes_comments_and_unicode() {
        let sql = "-- 中文注释;\nSELECT 'a;''中;文', `列;名`, \"值;\" /* ; 中文 */;\n# 注释;\nSELECT 2--1; -- only comment";
        let parts = split_statements(sql);
        assert_eq!(parts.len(), 2);
        assert!(parts[0].contains("/* ; 中文 */"));
        assert!(parts[1].ends_with("SELECT 2--1"));
        assert_eq!(first_keyword(&parts[0]), "SELECT");
        assert!(split_statements("-- comment\n/* 中文 */ # comment").is_empty());
        assert_eq!(split_statements("(SELECT 1); /*!40101 SET NAMES utf8mb4 */;" ).len(), 2);
    }

    #[test]
    fn custom_delimiters_use_bytes_without_skipping_following_sql() {
        let sql = "-- procedure\nDELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT '中文;'; SELECT 2; END$$\nDELIMITER ;\nSELECT 3;";
        let parts = split_statements(sql);
        assert_eq!(parts.len(), 2, "{parts:?}");
        assert!(parts[0].ends_with("END"));
        assert_eq!(parts[1], "SELECT 3");
        assert!(split_statements("DELIMITER ;").is_empty());
        assert_eq!(split_statements("SELECT delimiter_column FROM t;"), vec!["SELECT delimiter_column FROM t"]);
    }
}
