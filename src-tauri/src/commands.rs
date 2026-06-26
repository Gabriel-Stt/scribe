use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;

use anyhow::Result;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::asr::{AsrEngine, Transcript};
use crate::audio::AudioHandle;
use crate::context_file;
use crate::db;
use crate::llm::{ChatMessage, LlmEngine};

pub struct AppState {
    pub asr: Arc<dyn AsrEngine>,
    pub llm: Arc<dyn LlmEngine>,
    pub db: Mutex<rusqlite::Connection>,
    pub sidecar: Mutex<Option<std::process::Child>>,
    pub llm_error: Mutex<Option<String>>,
}

fn data_dir(app: &AppHandle) -> Result<PathBuf> {
    app.path()
        .app_data_dir()
        .map_err(|e| anyhow::anyhow!("Could not determine app data dir: {e}"))
}

fn recordings_dir(app: &AppHandle) -> Result<PathBuf> {
    let dir = data_dir(app)?.join("recordings");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn map_err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

// ---- Status ----------------------------------------------------------------

#[derive(Serialize)]
pub struct StatusResponse {
    pub asr_ready: bool,
    pub llm_ready: bool,
    pub llm_error: Option<String>,
    pub recording_status: String,
}

#[tauri::command]
pub async fn get_status(
    state: State<'_, AppState>,
    audio: State<'_, AudioHandle>,
) -> Result<StatusResponse, String> {
    let asr_ready = state.asr.is_ready().await;
    let llm_error = state.llm_error.lock().unwrap().clone();
    let llm_ready = llm_error.is_none();
    let recording_status = audio.status().await;
    Ok(StatusResponse {
        asr_ready,
        llm_ready,
        llm_error,
        recording_status,
    })
}

// ---- Recording -------------------------------------------------------------

#[tauri::command]
pub async fn start_recording(
    app: AppHandle,
    audio: State<'_, AudioHandle>,
) -> Result<(), String> {
    let dir = recordings_dir(&app).map_err(map_err)?;
    let timestamp = chrono::Local::now().format("%Y-%m-%d_%H-%M-%S").to_string();
    let path = dir.join(format!("{timestamp}.wav"));
    audio.start(path).await.map_err(map_err)
}

#[tauri::command]
pub async fn pause_recording(audio: State<'_, AudioHandle>) -> Result<(), String> {
    audio.pause().await.map_err(map_err)
}

#[tauri::command]
pub async fn resume_recording(audio: State<'_, AudioHandle>) -> Result<(), String> {
    audio.resume().await.map_err(map_err)
}

#[tauri::command]
pub async fn stop_recording(audio: State<'_, AudioHandle>) -> Result<String, String> {
    let path = audio.stop().await.map_err(map_err)?;
    Ok(path.to_string_lossy().to_string())
}

// ---- Transcription ---------------------------------------------------------

#[tauri::command]
pub async fn transcribe_audio(
    state: State<'_, AppState>,
    audio_path: String,
) -> Result<Transcript, String> {
    if !state.asr.is_ready().await {
        return Err("ASR model is still loading. Please wait a moment.".to_string());
    }
    state
        .asr
        .transcribe(std::path::Path::new(&audio_path))
        .await
        .map_err(map_err)
}

// ---- Meeting & Summary -----------------------------------------------------

#[derive(Deserialize)]
pub struct CreateMeetingArgs {
    pub title: String,
    pub audio_path: String,
    pub transcript: Transcript,
}

#[derive(Serialize)]
pub struct MeetingResult {
    pub meeting_id: String,
    pub summary: String,
}

#[tauri::command]
pub async fn create_meeting(
    app: AppHandle,
    state: State<'_, AppState>,
    args: CreateMeetingArgs,
) -> Result<MeetingResult, String> {
    let meeting_id = uuid::Uuid::new_v4().to_string();
    let full_text = args.transcript.full_text.clone();

    // Persist meeting and segments
    {
        let conn = state.db.lock().unwrap();
        db::insert_meeting(
            &conn,
            &meeting_id,
            &args.title,
            &args.audio_path,
            &full_text,
            None,
        )
        .map_err(map_err)?;

        let segs: Vec<(f64, f64, &str)> = args
            .transcript
            .segments
            .iter()
            .map(|s| (s.start, s.end, s.text.as_str()))
            .collect();
        db::insert_transcript_segments(&conn, &meeting_id, &segs).map_err(map_err)?;
    }

    // Generate initial summary
    let summary = generate_summary_inner(&app, &state, &meeting_id, &full_text, None)
        .await
        .map_err(map_err)?;

    Ok(MeetingResult { meeting_id, summary })
}

async fn generate_summary_inner(
    app: &AppHandle,
    state: &AppState,
    meeting_id: &str,
    full_text: &str,
    instruction: Option<&str>,
) -> Result<String> {
    let data_dir = data_dir(app)?;
    let context_md = context_file::load_context(&data_dir);

    let messages = match instruction {
        Some(instr) => {
            context_file::build_resummary_messages(full_text, &context_md, instr)
        }
        None => context_file::build_summarization_messages(full_text, &context_md),
    };

    let summary = state.llm.chat(messages).await?;

    let version = {
        let conn = state.db.lock().unwrap();
        let v = db::next_summary_version(&conn, meeting_id)?;
        db::insert_summary(&conn, meeting_id, v, &summary)?;
        v
    };

    let _ = version; // will be used in Phase 2 version history UI
    Ok(summary)
}

#[derive(Deserialize)]
pub struct ResummarizeArgs {
    pub meeting_id: String,
    pub instruction: String,
}

#[tauri::command]
pub async fn resummmarize(
    app: AppHandle,
    state: State<'_, AppState>,
    args: ResummarizeArgs,
) -> Result<String, String> {
    let full_text = {
        let conn = state.db.lock().unwrap();
        db::get_full_text(&conn, &args.meeting_id)
            .map_err(map_err)?
            .ok_or_else(|| "Meeting not found".to_string())?
    };

    generate_summary_inner(&app, &state, &args.meeting_id, &full_text, Some(&args.instruction))
        .await
        .map_err(map_err)
}

// ---- Chat ------------------------------------------------------------------

#[derive(Deserialize)]
pub struct ChatArgs {
    pub meeting_id: String,
    pub message: String,
}

#[derive(Serialize)]
pub struct ChatResponse {
    pub response: String,
}

#[tauri::command]
pub async fn send_chat_message(
    app: AppHandle,
    state: State<'_, AppState>,
    args: ChatArgs,
) -> Result<ChatResponse, String> {
    let full_text = {
        let conn = state.db.lock().unwrap();
        db::get_full_text(&conn, &args.meeting_id)
            .map_err(map_err)?
            .ok_or_else(|| "Meeting not found".to_string())?
    };

    let history = {
        let conn = state.db.lock().unwrap();
        db::get_chat_history(&conn, &args.meeting_id).map_err(map_err)?
    };

    let mut messages = vec![context_file::build_chat_system_message(&full_text)];
    for (role, content) in &history {
        messages.push(ChatMessage { role: role.clone(), content: content.clone() });
    }
    messages.push(ChatMessage::user(args.message.clone()));

    let on_chunk = std::sync::Arc::new(move |chunk: String| {
        let _ = app.emit("chat-chunk", chunk);
    });

    let response = state.llm.chat_streaming(messages, on_chunk).await.map_err(map_err)?;

    {
        let conn = state.db.lock().unwrap();
        db::insert_chat_message(&conn, &args.meeting_id, "user", &args.message)
            .map_err(map_err)?;
        db::insert_chat_message(&conn, &args.meeting_id, "assistant", &response)
            .map_err(map_err)?;
    }

    Ok(ChatResponse { response })
}

// ---- Context file ----------------------------------------------------------

#[tauri::command]
pub async fn save_preference(
    app: AppHandle,
    instruction: String,
) -> Result<(), String> {
    let data_dir = data_dir(&app).map_err(map_err)?;
    context_file::append_to_context(&data_dir, &instruction).map_err(map_err)
}

#[tauri::command]
pub async fn get_context(app: AppHandle) -> Result<String, String> {
    let data_dir = data_dir(&app).map_err(map_err)?;
    Ok(context_file::load_context(&data_dir))
}

#[tauri::command]
pub async fn save_context(app: AppHandle, content: String) -> Result<(), String> {
    let data_dir = data_dir(&app).map_err(map_err)?;
    context_file::save_context(&data_dir, &content).map_err(map_err)
}
