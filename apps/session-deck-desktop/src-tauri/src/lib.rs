pub mod commands;
pub mod doctor;
pub mod helper_runner;
pub mod runtime;

use tauri::{
    tray::{MouseButton, MouseButtonState, TrayIconEvent},
    Manager,
};

fn should_restore_main_window(button: MouseButton, state: MouseButtonState) -> bool {
    button == MouseButton::Left && state == MouseButtonState::Up
}

pub fn run() {
    tauri::Builder::default()
        .on_tray_icon_event(|app, event| {
            if let TrayIconEvent::Click {
                button,
                button_state,
                ..
            } = event
            {
                if should_restore_main_window(button, button_state) {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.unminimize();
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::load_snapshot,
            commands::preview_worktree_base_ref,
            commands::preview_worktree_launch_context,
            commands::create_worktree,
            commands::create_session,
            commands::open_terminal,
            commands::kill_session,
            commands::restart_session,
            commands::open_external,
            commands::copy_text,
            commands::doctor_status,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Session Deck desktop application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restores_only_for_left_button_release() {
        assert!(should_restore_main_window(
            MouseButton::Left,
            MouseButtonState::Up,
        ));

        for (button, state) in [
            (MouseButton::Left, MouseButtonState::Down),
            (MouseButton::Right, MouseButtonState::Up),
            (MouseButton::Middle, MouseButtonState::Up),
        ] {
            assert!(!should_restore_main_window(button, state));
        }
    }
}
