use std::io::{Seek, SeekFrom, Write};
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
    /// Path of the WAV file currently being recorded (set by start_recording, cleared by stop_recording)
    pub current_recording_path: Mutex<Option<PathBuf>>,
    /// Oneshot sender to cancel the live-transcription background task
    pub live_stop: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
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

/// Patch a WAV file's RIFF/data chunk sizes to match its current on-disk length.
/// Hound leaves these as 0 until finalize(); we fix them so parakeet can read
/// a snapshot of the file while recording is still in progress.
fn fix_wav_header(path: &std::path::Path) -> Result<()> {
    let file_len = std::fs::metadata(path)?.len();
    if file_len < 44 {
        return Ok(());
    }
    let riff_size = ((file_len.saturating_sub(8)) as u32).to_le_bytes();
    let data_size = ((file_len.saturating_sub(44)) as u32).to_le_bytes();

    let mut f = std::fs::OpenOptions::new().write(true).open(path)?;
    f.seek(SeekFrom::Start(4))?;
    f.write_all(&riff_size)?;
    f.seek(SeekFrom::Start(40))?;
    f.write_all(&data_size)?;
    Ok(())
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
    Ok(StatusResponse { asr_ready, llm_ready, llm_error, recording_status })
}

// ---- Recording -------------------------------------------------------------

#[tauri::command]
pub async fn start_recording(
    app: AppHandle,
    state: State<'_, AppState>,
    audio: State<'_, AudioHandle>,
) -> Result<(), String> {
    let dir = recordings_dir(&app).map_err(map_err)?;
    let timestamp = chrono::Local::now().format("%Y-%m-%d_%H-%M-%S").to_string();
    let path = dir.join(format!("{timestamp}.wav"));

    audio.start(path.clone()).await.map_err(map_err)?;

    // Stash the recording path so the live-transcription task can find it
    *state.current_recording_path.lock().unwrap() = Some(path.clone());

    // Spawn background live-transcription task
    let (stop_tx, stop_rx) = tokio::sync::oneshot::channel::<()>();
    *state.live_stop.lock().unwrap() = Some(stop_tx);

    let asr = state.asr.clone();
    let app2 = app.clone();

    tauri::async_runtime::spawn(async move {
        let mut stop_rx = stop_rx;
        let mut last_end_time = 0.0f64;

        loop {
            tokio::select! {
                _ = tokio::time::sleep(std::time::Duration::from_secs(20)) => {}
                _ = &mut stop_rx => break,
            }

            // Get the current recording path from managed state
            let src = {
                let s = app2.state::<AppState>();
                let p = s.current_recording_path.lock().unwrap().clone();
                p
            };
            let Some(src) = src else { break };

            // Copy + fix header
            let tmp = src.with_extension("snap.wav");
            if std::fs::copy(&src, &tmp).is_err() {
                continue;
            }
            if fix_wav_header(&tmp).is_err() {
                let _ = std::fs::remove_file(&tmp);
                continue;
            }

            // Transcribe the snapshot; emit only genuinely new segments
            if let Ok(tx) = asr.transcribe(&tmp).await {
                for seg in &tx.segments {
                    if seg.end > last_end_time + 0.1 {
                        let _ = app2.emit("transcript-live-segment", seg);
                        last_end_time = seg.end;
                    }
                }
            }

            let _ = std::fs::remove_file(&tmp);
        }
    });

    Ok(())
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
pub async fn stop_recording(
    state: State<'_, AppState>,
    audio: State<'_, AudioHandle>,
) -> Result<String, String> {
    // Cancel live-transcription task
    if let Some(tx) = state.live_stop.lock().unwrap().take() {
        let _ = tx.send(());
    }
    *state.current_recording_path.lock().unwrap() = None;

    let path = audio.stop().await.map_err(map_err)?;
    Ok(path.to_string_lossy().to_string())
}

// ---- Transcription ---------------------------------------------------------

#[tauri::command]
pub async fn transcribe_audio(
    app: AppHandle,
    state: State<'_, AppState>,
    audio_path: String,
) -> Result<Transcript, String> {
    if !state.asr.is_ready().await {
        return Err("ASR model is still loading. Please wait a moment.".to_string());
    }
    let transcript = state
        .asr
        .transcribe(std::path::Path::new(&audio_path))
        .await
        .map_err(map_err)?;

    // Emit the definitive segments so the UI can show the final transcript
    // as it "types in" — the frontend replaces any live-segment preview with these
    for seg in &transcript.segments {
        let _ = app.emit("transcript-segment", seg);
    }

    Ok(transcript)
}

// ---- Meeting & Summary -----------------------------------------------------

#[derive(Deserialize)]
pub struct CreateMeetingArgs {
    pub title: String,
    pub audio_path: String,
    pub transcript: Transcript,
    pub duration_seconds: Option<f64>,
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

    // Persist meeting and transcript segments
    {
        let conn = state.db.lock().unwrap();
        db::insert_meeting(
            &conn,
            &meeting_id,
            &args.title,
            &args.audio_path,
            &full_text,
            args.duration_seconds,
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

    // Generate summary
    let summary =
        generate_summary_inner(&app, &state, &meeting_id, &full_text, None)
            .await
            .map_err(map_err)?;

    // Auto-generate title in the background; emits "meeting-title-ready" when done
    let llm = state.llm.clone();
    let mid = meeting_id.clone();
    let excerpt = full_text.chars().take(2000).collect::<String>();
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        let msgs = context_file::build_title_messages(&excerpt);
        if let Ok(title) = llm.chat(msgs).await {
            let title = title.trim().trim_matches('"').to_string();
            let s = app2.state::<AppState>();
            let conn = s.db.lock().unwrap();
            let _ = db::update_meeting_title(&conn, &mid, &title);
            drop(conn);
            let _ = app2.emit("meeting-title-ready", (&mid, &title));
        }
    });

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
        Some(instr) => context_file::build_resummary_messages(full_text, &context_md, instr),
        None => context_file::build_summarization_messages(full_text, &context_md),
    };

    let summary = state.llm.chat(messages).await?;

    {
        let conn = state.db.lock().unwrap();
        let v = db::next_summary_version(&conn, meeting_id)?;
        db::insert_summary(&conn, meeting_id, v, &summary)?;
    }

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

// ---- Phase 2: Meetings list & detail ---------------------------------------

#[derive(Serialize)]
pub struct MeetingListItem {
    pub id: String,
    pub title: String,
    pub subject_tag: Option<String>,
    pub created_at: String,
    pub duration_seconds: Option<f64>,
}

#[tauri::command]
pub async fn list_meetings(
    state: State<'_, AppState>,
    search: Option<String>,
) -> Result<Vec<MeetingListItem>, String> {
    let conn = state.db.lock().unwrap();
    let rows = db::list_meetings(&conn, search.as_deref()).map_err(map_err)?;
    Ok(rows
        .into_iter()
        .map(|r| MeetingListItem {
            id: r.id,
            title: r.title,
            subject_tag: r.subject_tag,
            created_at: r.created_at,
            duration_seconds: r.duration_seconds,
        })
        .collect())
}

#[derive(Serialize)]
pub struct TranscriptSegmentItem {
    pub start: f64,
    pub end: f64,
    pub text: String,
}

#[derive(Serialize)]
pub struct NoteItem {
    pub id: String,
    pub elapsed_seconds: f64,
    pub text: String,
}

#[derive(Serialize)]
pub struct SummaryVersionItem {
    pub version: i64,
    pub content: String,
    pub created_at: String,
}

#[derive(Serialize)]
pub struct StoredChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Serialize)]
pub struct MeetingDetail {
    pub id: String,
    pub title: String,
    pub subject_tag: Option<String>,
    pub created_at: String,
    pub duration_seconds: Option<f64>,
    pub audio_path: Option<String>,
    pub segments: Vec<TranscriptSegmentItem>,
    pub notes: Vec<NoteItem>,
    pub summaries: Vec<SummaryVersionItem>,
    pub chat_messages: Vec<StoredChatMessage>,
}

#[tauri::command]
pub async fn get_meeting_detail(
    state: State<'_, AppState>,
    meeting_id: String,
) -> Result<MeetingDetail, String> {
    let conn = state.db.lock().unwrap();

    let row = db::get_meeting(&conn, &meeting_id)
        .map_err(map_err)?
        .ok_or_else(|| "Meeting not found".to_string())?;

    let segments = db::get_transcript_segments(&conn, &meeting_id)
        .map_err(map_err)?
        .into_iter()
        .map(|(s, e, t)| TranscriptSegmentItem { start: s, end: e, text: t })
        .collect();

    let notes = db::get_manual_notes(&conn, &meeting_id)
        .map_err(map_err)?
        .into_iter()
        .map(|n| NoteItem { id: n.id, elapsed_seconds: n.elapsed_seconds, text: n.text })
        .collect();

    let summaries = db::get_summaries(&conn, &meeting_id)
        .map_err(map_err)?
        .into_iter()
        .map(|s| SummaryVersionItem {
            version: s.version,
            content: s.content,
            created_at: s.created_at,
        })
        .collect();

    let chat_messages = db::get_chat_history(&conn, &meeting_id)
        .map_err(map_err)?
        .into_iter()
        .map(|(role, content)| StoredChatMessage { role, content })
        .collect();

    Ok(MeetingDetail {
        id: row.id,
        title: row.title,
        subject_tag: row.subject_tag,
        created_at: row.created_at,
        duration_seconds: row.duration_seconds,
        audio_path: row.audio_path,
        segments,
        notes,
        summaries,
        chat_messages,
    })
}

#[derive(Deserialize)]
pub struct UpdateMeetingArgs {
    pub id: String,
    pub title: Option<String>,
    pub subject_tag: Option<String>, // use "" to clear
}

#[tauri::command]
pub async fn update_meeting(
    state: State<'_, AppState>,
    args: UpdateMeetingArgs,
) -> Result<(), String> {
    let conn = state.db.lock().unwrap();
    if let Some(title) = &args.title {
        db::update_meeting_title(&conn, &args.id, title).map_err(map_err)?;
    }
    if let Some(tag) = &args.subject_tag {
        let tag_opt = if tag.is_empty() { None } else { Some(tag.as_str()) };
        db::update_meeting_subject(&conn, &args.id, tag_opt).map_err(map_err)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn delete_meeting(
    state: State<'_, AppState>,
    meeting_id: String,
) -> Result<(), String> {
    let conn = state.db.lock().unwrap();
    db::delete_meeting(&conn, &meeting_id).map_err(map_err)
}

// ---- Summary version history -----------------------------------------------

#[tauri::command]
pub async fn restore_summary(
    app: AppHandle,
    state: State<'_, AppState>,
    meeting_id: String,
    version: i64,
) -> Result<String, String> {
    let content = {
        let conn = state.db.lock().unwrap();
        db::get_summaries(&conn, &meeting_id)
            .map_err(map_err)?
            .into_iter()
            .find(|s| s.version == version)
            .map(|s| s.content)
            .ok_or_else(|| "Summary version not found".to_string())?
    };

    // Save as a new (latest) version rather than mutating history
    {
        let conn = state.db.lock().unwrap();
        let v = db::next_summary_version(&conn, &meeting_id).map_err(map_err)?;
        db::insert_summary(&conn, &meeting_id, v, &content).map_err(map_err)?;
    }

    let _ = app.emit("summary-restored", (&meeting_id, &content));
    Ok(content)
}

// ---- Manual notes ----------------------------------------------------------

#[derive(Deserialize)]
pub struct AddNoteArgs {
    pub meeting_id: String,
    pub elapsed_seconds: f64,
    pub text: String,
}

#[tauri::command]
pub async fn add_manual_note(
    state: State<'_, AppState>,
    args: AddNoteArgs,
) -> Result<(), String> {
    let conn = state.db.lock().unwrap();
    db::insert_manual_note(&conn, &args.meeting_id, args.elapsed_seconds, &args.text)
        .map_err(map_err)
}

// ---- Export ----------------------------------------------------------------

#[tauri::command]
pub async fn export_meeting_markdown(
    state: State<'_, AppState>,
    meeting_id: String,
) -> Result<String, String> {
    let conn = state.db.lock().unwrap();

    let row = db::get_meeting(&conn, &meeting_id)
        .map_err(map_err)?
        .ok_or_else(|| "Meeting not found".to_string())?;

    let summaries = db::get_summaries(&conn, &meeting_id).map_err(map_err)?;
    let latest_summary = summaries.first().map(|s| s.content.as_str());

    let segments_raw = db::get_transcript_segments(&conn, &meeting_id).map_err(map_err)?;
    let segments: Vec<(f64, f64, &str)> = segments_raw
        .iter()
        .map(|(s, e, t)| (*s, *e, t.as_str()))
        .collect();

    let notes_raw = db::get_manual_notes(&conn, &meeting_id).map_err(map_err)?;
    let notes: Vec<(f64, &str)> = notes_raw
        .iter()
        .map(|n| (n.elapsed_seconds, n.text.as_str()))
        .collect();

    let md = context_file::build_markdown_export(
        &row.title,
        row.subject_tag.as_deref(),
        &row.created_at,
        row.duration_seconds,
        latest_summary,
        &segments,
        &notes,
    );

    Ok(md)
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

    let on_chunk = Arc::new({
        let app = app.clone();
        move |chunk: String| {
            let _ = app.emit("chat-chunk", chunk);
        }
    });

    let response =
        state.llm.chat_streaming(messages, on_chunk).await.map_err(map_err)?;

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
pub async fn save_preference(app: AppHandle, instruction: String) -> Result<(), String> {
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
