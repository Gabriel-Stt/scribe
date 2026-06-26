mod asr;
mod audio;
mod commands;
mod context_file;
mod db;
mod llm;

use std::sync::Arc;
use std::sync::Mutex;

use commands::AppState;
use tauri::Manager;

const SIDECAR_DIR: &str = env!("SIDECAR_DIR");
const PARAKEET_PORT: u16 = 8765;
const OLLAMA_BASE_URL: &str = "http://localhost:11434/v1";
const OLLAMA_MODEL: &str = "qwen3.5:9b";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
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
            commands::save_preference,
            commands::get_context,
            commands::save_context,
            // Phase 2
            commands::list_meetings,
            commands::get_meeting_detail,
            commands::update_meeting,
            commands::delete_meeting,
            commands::restore_summary,
            commands::add_manual_note,
            commands::export_meeting_markdown,
        ])
        .build(tauri::generate_context!())
        .expect("error building Tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
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
            }
        });
}

fn spawn_parakeet_sidecar(
    sidecar_dir: &str,
    port: u16,
) -> std::io::Result<std::process::Child> {
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
