use std::fs::{self, File};
use std::io::Read;
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use crate::models::ConnectionProfile;

pub struct Tunnel {
    child: Child,
    pub local_port: u16,
    log_path: PathBuf,
}

impl Drop for Tunnel {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_file(&self.log_path);
    }
}

fn free_local_port() -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| format!("无法分配 SSH 本地端口: {e}"))?;
    Ok(listener.local_addr().map_err(|e| e.to_string())?.port())
}

pub fn start(profile: &ConnectionProfile) -> Result<Tunnel, String> {
    if profile.ssh_host.trim().is_empty() || profile.ssh_user.trim().is_empty() {
        return Err("SSH 主机和用户名不能为空".into());
    }
    if profile.ssh_auth == "password" {
        return Err("当前 Tauri 版本 SSH 仅支持私钥认证，请使用私钥登录".into());
    }
    let key = profile.ssh_key_path.trim();
    if key.is_empty() {
        return Err("SSH 私钥路径不能为空".into());
    }
    let local_port = free_local_port()?;
    let log_path = std::env::temp_dir().join(format!("finch-ssh-{}-{}.log", std::process::id(), local_port));
    let log = File::create(&log_path).map_err(|e| format!("无法创建 SSH 日志: {e}"))?;
    let log_err = log.try_clone().map_err(|e| e.to_string())?;
    let forward = format!("127.0.0.1:{}:{}:{}", local_port, profile.host, profile.port);
    let mut cmd = Command::new("/usr/bin/ssh");
    cmd.args([
        "-o", "BatchMode=yes",
        "-o", "ExitOnForwardFailure=yes",
        "-o", "StrictHostKeyChecking=accept-new",
        "-o", "ConnectTimeout=8",
        "-o", "ServerAliveInterval=30",
        "-N", "-L", &forward,
        "-p", &profile.ssh_port.to_string(),
        "-i", key,
    ]);
    cmd.arg(format!("{}@{}", profile.ssh_user.trim(), profile.ssh_host.trim()))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(log_err));
    let mut child = cmd.spawn().map_err(|e| format!("无法启动 ssh: {e}"))?;
    let deadline = Instant::now() + Duration::from_secs(12);
    loop {
        if TcpStream::connect_timeout(
            &format!("127.0.0.1:{local_port}").parse().map_err(|e| format!("本地地址解析失败: {e}"))?,
            Duration::from_millis(300),
        )
        .is_ok()
        {
            return Ok(Tunnel { child, local_port, log_path });
        }
        if let Ok(Some(status)) = child.try_wait() {
            let mut detail = String::new();
            if let Ok(mut f) = File::open(&log_path) {
                let _ = f.read_to_string(&mut detail);
            }
            let _ = fs::remove_file(&log_path);
            return Err(format!("SSH 隧道启动失败 (exit {status}): {}", detail.trim()));
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            let _ = fs::remove_file(&log_path);
            return Err("SSH 隧道启动超时（12 秒）".into());
        }
        std::thread::sleep(Duration::from_millis(120));
    }
}
