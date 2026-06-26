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

            // Ensure app data dir exists
            let data_dir = app_handle.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;

            // Open SQLite DB
            let db_path = data_dir.join("scribe.db");
            let conn = rusqlite::Connection::open(&db_path)?;
            db::init(&conn)?;

            // Spawn parakeet sidecar
            let sidecar_child = spawn_parakeet_sidecar(SIDECAR_DIR, PARAKEET_PORT);

            // Build ASR engine
            let asr: Arc<dyn asr::AsrEngine> =
                Arc::new(asr::parakeet::ParakeetSidecarEngine::new(PARAKEET_PORT));

            // Build LLM engine and check health asynchronously
            let ollama = Arc::new(llm::openai_compat::OllamaEngine::new(
                OLLAMA_BASE_URL,
                OLLAMA_MODEL,
            ));
            let llm: Arc<dyn llm::LlmEngine> = ollama.clone();
            let llm_error: Mutex<Option<String>> = Mutex::new(None);

            // Check Ollama health in background (non-blocking startup)
            let ollama_check = ollama.clone();

            let state = AppState {
                asr,
                llm,
                db: Mutex::new(conn),
                sidecar: Mutex::new(sidecar_child.ok()),
                llm_error,
            };

            app.manage(state);
            app.manage(audio::spawn_audio_thread());

            // Kick off the Ollama health check; result goes into AppState.llm_error
            let handle2 = app_handle.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = ollama_check.check_health().await {
                    eprintln!("[scribe] Ollama health check failed: {e}");
                    if let Some(s) = handle2.try_state::<AppState>() {
                        *s.llm_error.lock().unwrap() = Some(e.to_string());
                    }
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
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
        ])
        .build(tauri::generate_context!())
        .expect("error building Tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                // Kill sidecar on exit
                if let Some(state) = app_handle.try_state::<AppState>() {
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
    // Build a PATH that includes Homebrew and user-local bins where uv/ffmpeg live
    let mut path = String::from("/opt/homebrew/bin:/usr/local/bin");
    if let Ok(home) = std::env::var("HOME") {
        path.push(':');
        path.push_str(&format!("{home}/.local/bin"));
    }
    if let Ok(existing) = std::env::var("PATH") {
        path.push(':');
        path.push_str(&existing);
    }

    // Find uv
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
