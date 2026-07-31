mod asr;
mod audio;
mod commands;
mod context_file;
mod db;
mod llm;

use std::sync::Arc;
use std::sync::Mutex;

use commands::AppState;
use tauri::{Emitter, Manager};

const SIDECAR_DIR: &str = env!("SIDECAR_DIR");
const PARAKEET_PORT: u16 = 8765;
const OLLAMA_BASE_URL: &str = "http://localhost:11434/v1";
const OLLAMA_MODEL: &str = "qwen3.5:9b";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    use tauri_plugin_global_shortcut::ShortcutState;
                    if event.state() == ShortcutState::Pressed {
                        let _ = app.emit("recording-shortcut", ());
                    }
                })
                .build(),
        )
        .setup(|app| {
            let app_handle = app.handle().clone();

            let data_dir = app_handle.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;

            let db_path = data_dir.join("scribe.db");
            let conn = rusqlite::Connection::open(&db_path)?;
            db::init(&conn)?;

            let sidecar_child = spawn_parakeet_sidecar(SIDECAR_DIR, PARAKEET_PORT);

            let asr: Arc<dyn asr::AsrEngine> =
                Arc::new(asr::parakeet::ParakeetSidecarEngine::new(PARAKEET_PORT));

            let ollama = Arc::new(llm::openai_compat::OllamaEngine::new(
                OLLAMA_BASE_URL,
                OLLAMA_MODEL,
            ));
            let llm: Arc<dyn llm::LlmEngine> = ollama.clone();

            let state = AppState {
                asr,
                llm,
                db: Mutex::new(conn),
                sidecar: Mutex::new(sidecar_child.ok()),
                llm_error: Mutex::new(None),
                current_recording_path: Mutex::new(None),
                live_stop: Mutex::new(None),
            };

            app.manage(state);
            app.manage(audio::spawn_audio_thread());

            // Register global shortcut Cmd+Shift+R
            use tauri_plugin_global_shortcut::GlobalShortcutExt;
            let _ = app.global_shortcut().register("CmdOrCtrl+Shift+R");

            let handle2 = app_handle.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = ollama.check_health().await {
                    eprintln!("[scribe] Ollama health check failed: {e}");
                    if let Some(s) = handle2.try_state::<AppState>() {
                        *s.llm_error.lock().unwrap() = Some(e.to_string());
                    }
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Phase 1
            commands::get_status,
            commands::start_recording,
            commands::pause_recording,
            commands::resume_recording,
            commands::stop_recording,
            commands::transcribe_audio,
            commands::create_meeting,
            commands::resummmarize,
            commands::send_chat_message,
            commands::send_standalone_chat,
            commands::save_preference,
            commands::get_context,
            commands::save_context,
            // Phase 2
            commands::list_meetings,
            commands::get_meeting_detail,
            commands::update_meeting,
            commands::delete_meeting,
            commands::list_trashed_meetings,
            commands::restore_meeting,
            commands::permanently_delete_meeting,
            commands::restore_summary,
            commands::add_manual_note,
            commands::save_meeting_notes,
            commands::export_meeting_markdown,
            commands::write_text_file,
            // Standalone notes
            commands::list_notes,
            commands::get_note,
            commands::create_note,
            commands::save_note,
            commands::delete_note,
            commands::delete_note_if_empty,
            commands::assign_note_folder,
            // Action items
            commands::extract_action_items,
            commands::save_action_items,
            // Note-meeting linking
            commands::link_note_to_meeting,
            commands::unlink_note_from_meeting,
            commands::get_note_linked_meetings,
            // Folders
            commands::list_folders,
            commands::create_folder,
            commands::delete_folder,
            commands::rename_folder,
            commands::assign_meeting_folder,
            // Tags
            commands::list_tags,
            commands::create_tag,
            commands::delete_tag,
            commands::set_meeting_tags,
            // Phase 3: new features
            commands::toggle_pin_meeting,
            commands::set_meeting_color,
            commands::get_app_settings,
            commands::save_app_settings,
            commands::list_audio_devices,
            commands::get_audio_level,
            commands::import_audio_file,
        ])
        .build(tauri::generate_context!())
        .expect("error building Tauri application")
        .run(|app_handle, event| {
            let should_cleanup = matches!(
                event,
                tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
            );
            if should_cleanup {
                if let Some(state) = app_handle.try_state::<AppState>() {
                    if let Some(tx) = state.live_stop.lock().unwrap().take() {
                        let _ = tx.send(());
                    }
                    if let Ok(mut child_guard) = state.sidecar.lock() {
                        if let Some(ref mut child) = *child_guard {
                            let _ = child.kill();
                        }
                    }
                }
                // Belt-and-suspenders: also kill by port in case the Child handle is stale.
                kill_port_occupants(PARAKEET_PORT);
            }
        });
}

fn kill_port_occupants(port: u16) {
    // Kill any stale process holding the port (e.g. sidecar left behind from a previous crash).
    let _ = std::process::Command::new("sh")
        .args([
            "-c",
            &format!("lsof -ti :{port} | xargs kill -9 2>/dev/null; true"),
        ])
        .status();
}

fn spawn_parakeet_sidecar(
    sidecar_dir: &str,
    port: u16,
) -> std::io::Result<std::process::Child> {
    kill_port_occupants(port);

    let mut path = String::from("/opt/homebrew/bin:/usr/local/bin");
    if let Ok(home) = std::env::var("HOME") {
        path.push(':');
        path.push_str(&format!("{home}/.local/bin"));
    }
    if let Ok(existing) = std::env::var("PATH") {
        path.push(':');
        path.push_str(&existing);
    }

    let uv_bin = find_executable(&["uv"], &path).unwrap_or_else(|| "uv".to_string());

    eprintln!("[scribe] launching sidecar: {uv_bin} run python main.py --port {port}");
    eprintln!("[scribe] sidecar dir: {sidecar_dir}");

    std::process::Command::new(&uv_bin)
        .env("PATH", &path)
        .args(["run", "python", "main.py", "--port", &port.to_string()])
        .current_dir(sidecar_dir)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::inherit())
        .spawn()
}

fn find_executable(names: &[&str], extra_path: &str) -> Option<String> {
    for name in names {
        for dir in extra_path.split(':') {
            let candidate = format!("{dir}/{name}");
            if std::path::Path::new(&candidate).is_file() {
                return Some(candidate);
            }
        }
    }
    None
}
