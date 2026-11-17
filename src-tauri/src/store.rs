use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::process::Command;

use crate::models::{AiProvider, AppSettings, ConnectionProfile, HistoryItem, SavedQuery};

const KEYCHAIN_PREFIX: &str = "com.finch.sql.connection.";
const AI_KEYCHAIN_PREFIX: &str = "com.finch.sql.ai.";

pub fn data_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("FINCH_DATA_DIR") {
        return PathBuf::from(dir);
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    PathBuf::from(home)
        .join("Library")
        .join("Application Support")
        .join("Finch")
}

pub fn ensure_dir() -> Result<(), String> {
    let dir = data_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建数据目录: {e}"))?;
    let _ = fs::set_permissions(&dir, fs::Permissions::from_mode(0o700));
    Ok(())
}

fn read_json<T: serde::de::DeserializeOwned + Default>(name: &str) -> T {
    let path = data_dir().join(name);
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn write_json<T: serde::Serialize + ?Sized>(name: &str, value: &T) -> Result<(), String> {
    ensure_dir()?;
    let dir = data_dir();
    let path = dir.join(name);
    let tmp = dir.join(format!("{name}.tmp"));
    let raw = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    fs::write(&tmp, raw).map_err(|e| format!("无法写入 {name}: {e}"))?;
    let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600));
    fs::rename(tmp, path).map_err(|e| format!("无法保存 {name}: {e}"))?;
    Ok(())
}

pub fn load_profiles() -> Vec<ConnectionProfile> {
    let mut profiles: Vec<ConnectionProfile> = read_json("connections.json");
    for profile in &mut profiles {
        if profile.id.is_empty() {
            profile.id = uuid::Uuid::new_v4().to_string();
        }
        if profile.category.is_empty() {
            profile.category = "local".into();
        }
        profile.has_password = profile_secret(&profile.id).is_some();
    }
    profiles
}

pub fn save_profiles(profiles: &[ConnectionProfile]) -> Result<(), String> {
    write_json("connections.json", profiles)
}

pub fn load_settings() -> AppSettings {
    read_json("settings.json")
}

pub fn save_settings(settings: &AppSettings) -> Result<(), String> {
    write_json("settings.json", settings)
}

pub fn load_history() -> Vec<HistoryItem> {
    read_json("history.json")
}

pub fn save_history(items: &[HistoryItem]) -> Result<(), String> {
    let trimmed: Vec<HistoryItem> = items.iter().take(500).cloned().collect();
    write_json("history.json", &trimmed)
}

pub fn load_snippets() -> Vec<SavedQuery> {
    read_json("snippets.json")
}

pub fn save_snippets(items: &[SavedQuery]) -> Result<(), String> {
    write_json("snippets.json", items)
}

pub fn load_ai_providers() -> Vec<AiProvider> {
    let mut items: Vec<AiProvider> = read_json("ai_providers.json");
    for item in &mut items {
        if item.id.is_empty() {
            item.id = uuid::Uuid::new_v4().to_string();
        }
        item.has_key = ai_secret(&item.id).is_some();
    }
    items
}

pub fn save_ai_providers(items: &[AiProvider]) -> Result<(), String> {
    write_json("ai_providers.json", items)
}

fn service_name(id: &str) -> String {
    format!("{KEYCHAIN_PREFIX}{id}")
}
fn ssh_service_name(id: &str) -> String {
    format!("{KEYCHAIN_PREFIX}ssh.{id}")
}
fn ai_service_name(id: &str) -> String {
    format!("{AI_KEYCHAIN_PREFIX}{id}")
}

fn set_secret_for(service: &str, account: &str, secret: &str) -> Result<(), String> {
    let output = Command::new("security")
        .args(["add-generic-password", "-U", "-a", account, "-s", service, "-w", secret])
        .output()
        .map_err(|e| format!("无法调用 macOS 钥匙串: {e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

fn get_secret_for(service: &str, account: &str) -> Option<String> {
    let output = Command::new("security")
        .args(["find-generic-password", "-a", account, "-s", service, "-w"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(
        String::from_utf8_lossy(&output.stdout)
            .trim_end_matches(['\n', '\r'])
            .to_string(),
    )
}

fn delete_secret_for(service: &str, account: &str) {
    let _ = Command::new("security")
        .args(["delete-generic-password", "-a", account, "-s", service])
        .output();
}

pub fn set_profile_secret(id: &str, secret: &str) -> Result<(), String> {
    if secret.is_empty() {
        delete_secret_for(&service_name(id), id);
        return Ok(());
    }
    set_secret_for(&service_name(id), id, secret)
}
pub fn profile_secret(id: &str) -> Option<String> {
    get_secret_for(&service_name(id), id)
}
pub fn delete_profile_secrets(id: &str) {
    delete_secret_for(&service_name(id), id);
    delete_secret_for(&ssh_service_name(id), id);
}

pub fn set_ssh_secret(id: &str, secret: &str) -> Result<(), String> {
    if secret.is_empty() {
        delete_secret_for(&ssh_service_name(id), id);
        return Ok(());
    }
    set_secret_for(&ssh_service_name(id), id, secret)
}
pub fn ssh_secret(id: &str) -> Option<String> {
    get_secret_for(&ssh_service_name(id), id)
}

pub fn set_ai_secret(id: &str, secret: &str) -> Result<(), String> {
    if secret.is_empty() {
        delete_secret_for(&ai_service_name(id), id);
        return Ok(());
    }
    set_secret_for(&ai_service_name(id), id, secret)
}
pub fn ai_secret(id: &str) -> Option<String> {
    get_secret_for(&ai_service_name(id), id)
}

pub fn write_text_file(path: &str, content: &str) -> Result<(), String> {
    if let Some(parent) = std::path::Path::new(path).parent() {
        let _ = fs::create_dir_all(parent);
    }
    fs::write(path, content).map_err(|e| format!("写入文件失败: {e}"))
}

pub fn read_text_file(path: &str) -> Result<String, String> {
    fs::read_to_string(path).map_err(|e| format!("读取文件失败: {e}"))
}
