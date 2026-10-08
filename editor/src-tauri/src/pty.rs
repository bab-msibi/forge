//! Pseudo-terminal sessions for the built-in terminal (ConPTY on Windows).
//!
//! Commands are `async` so Tauri runs them off the UI thread: PTY writes and
//! ConPTY teardown can block, and a blocked UI thread freezes the window.

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use std::{
    collections::HashMap,
    io::{Read, Write},
    path::PathBuf,
    sync::{
        atomic::{AtomicU32, Ordering},
        Arc, Mutex,
    },
    thread,
};
use tauri::{ipc::Channel, AppHandle, Manager, State};

struct Session {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    pid: Option<u32>,
}

impl Session {
    /// Kill the shell *and* everything it started (e.g. a `bun run dev` server),
    /// so closed terminals don't leave processes holding ports.
    fn kill_tree(&self) -> Result<(), String> {
        #[cfg(windows)]
        if let Some(pid) = self.pid {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            let status = std::process::Command::new("taskkill")
                .args(["/T", "/F", "/PID", &pid.to_string()])
                .creation_flags(CREATE_NO_WINDOW)
                .status();
            if matches!(status, Ok(s) if s.success()) {
                return Ok(());
            }
        }
        self.killer.lock().unwrap().kill().map_err(|e| e.to_string())
    }
}

#[derive(Default)]
pub struct PtyState {
    next_id: AtomicU32,
    sessions: Mutex<HashMap<u32, Arc<Session>>>,
}

impl PtyState {
    /// Look up a session without holding the map lock while using it.
    /// Kill every session; used when the app exits.
    pub fn kill_all(&self) {
        let sessions: Vec<_> = self.sessions.lock().unwrap().values().cloned().collect();
        for session in sessions {
            let _ = session.kill_tree();
        }
    }

    fn get(&self, id: u32) -> Result<Arc<Session>, String> {
        self.sessions
            .lock()
            .unwrap()
            .get(&id)
            .cloned()
            .ok_or_else(|| "terminal has exited".into())
    }
}

fn default_shell() -> CommandBuilder {
    if cfg!(windows) {
        // Prefer PowerShell 7 when installed, fall back to Windows PowerShell
        let shell = which("pwsh.exe").unwrap_or_else(|| "powershell.exe".into());
        let mut cmd = CommandBuilder::new(shell);
        cmd.arg("-NoLogo");
        cmd
    } else {
        CommandBuilder::new(std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into()))
    }
}

fn which(exe: &str) -> Option<String> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(exe))
        .find(|p| p.is_file())
        .map(|p| p.to_string_lossy().into_owned())
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from)
}

/// Start a shell. Output bytes stream through `on_data`; the exit code arrives on `on_exit`.
#[tauri::command]
pub async fn pty_spawn(
    app: AppHandle,
    state: State<'_, PtyState>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    on_data: Channel<tauri::ipc::Response>,
    on_exit: Channel<u32>,
) -> Result<u32, String> {
    let pair = native_pty_system()
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    let mut cmd = default_shell();
    if let Some(dir) = cwd.map(PathBuf::from).filter(|d| d.is_dir()).or_else(home_dir) {
        cmd.cwd(dir);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let killer = child.clone_killer();
    let pid = child.process_id();

    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    state.sessions.lock().unwrap().insert(
        id,
        Arc::new(Session {
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            killer: Mutex::new(killer),
            pid,
        }),
    );

    // Pump output to the frontend as raw bytes (xterm.js decodes UTF-8 across chunks)
    thread::spawn(move || {
        let mut buf = [0u8; 16 * 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if on_data.send(tauri::ipc::Response::new(buf[..n].to_vec())).is_err() {
                        break;
                    }
                }
            }
        }
    });

    // Wait for the shell to exit, then release the PTY so the reader thread unblocks
    thread::spawn(move || {
        let code = child.wait().map(|s| s.exit_code()).unwrap_or(1);
        let session = app.state::<PtyState>().sessions.lock().unwrap().remove(&id);
        let _ = on_exit.send(code);
        // ConPTY teardown can block; do it here, after the map lock is released
        drop(session);
    });

    Ok(id)
}

#[tauri::command]
pub async fn pty_write(state: State<'_, PtyState>, id: u32, data: String) -> Result<(), String> {
    let session = state.get(id)?;
    let mut writer = session.writer.lock().unwrap();
    writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn pty_resize(state: State<'_, PtyState>, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    let session = state.get(id)?;
    let master = session.master.lock().unwrap();
    master
        .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn pty_kill(state: State<'_, PtyState>, id: u32) -> Result<(), String> {
    if let Ok(session) = state.get(id) {
        session.kill_tree()?;
    }
    Ok(())
}
