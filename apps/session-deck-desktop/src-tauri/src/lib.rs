pub mod commands;
pub mod doctor;
pub mod helper_runner;
pub mod runtime;

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            commands::load_snapshot,
            commands::preview_worktree_base_ref,
            commands::preview_worktree_launch_context,
            commands::create_worktree,
            commands::create_session,
            commands::open_terminal,
            commands::kill_session,
            commands::open_external,
            commands::copy_text,
            commands::doctor_status,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Session Deck desktop application");
}
