mod pty;
mod workspace;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        // Remembers folders picked in the dialog, so the last session can reopen them
        .plugin(tauri_plugin_persisted_scope::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(pty::PtyState::default())
        .manage(workspace::WorkspaceState::default())
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            workspace::workspace_open,
            workspace::workspace_files,
            workspace::workspace_search,
            workspace::workspace_create,
            workspace::workspace_rename,
            workspace::workspace_trash,
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Don't leave dev servers running after the editor closes
            if let tauri::RunEvent::Exit = event {
                app.state::<pty::PtyState>().kill_all();
            }
        });
}
