use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
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
    pub current_recording_path: Mutex<Option<PathBuf>>,
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

fn recordings_dir_resolved(data: &Path, conn: &rusqlite::Connection) -> Result<PathBuf> {
    let custom = db::get_setting(conn, "recordings_dir").ok().flatten();
    let dir = match custom.as_deref().filter(|s| !s.is_empty()) {
        Some(p) => PathBuf::from(p),
        None => data.join("recordings"),
    };
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn map_err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

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

// ---- App Settings -----------------------------------------------------------

#[derive(Serialize, Deserialize)]
pub struct AppSettings {
    pub auto_delete_audio: bool,
    pub recordings_dir: Option<String>,
    pub selected_device: Option<String>,
    pub sort_by: String,
    pub default_tag: Option<String>,
}

#[tauri::command]
pub async fn get_app_settings(state: State<'_, AppState>) -> Result<AppSettings, String> {
    let conn = state.db.lock().unwrap();
    Ok(AppSettings {
        auto_delete_audio: db::get_setting(&conn, "auto_delete_audio")
            .ok()
            .flatten()
            .as_deref()
            == Some("true"),
        recordings_dir: db::get_setting(&conn, "recordings_dir")
            .ok()
            .flatten()
            .filter(|s| !s.is_empty()),
        selected_device: db::get_setting(&conn, "selected_device")
            .ok()
            .flatten()
            .filter(|s| !s.is_empty()),
        sort_by: db::get_setting(&conn, "sort_by")
            .ok()
            .flatten()
            .unwrap_or_else(|| "date_desc".to_string()),
        default_tag: db::get_setting(&conn, "default_tag")
            .ok()
            .flatten()
            .filter(|s| !s.is_empty()),
    })
}

#[tauri::command]
pub async fn save_app_settings(
    state: State<'_, AppState>,
    settings: AppSettings,
) -> Result<(), String> {
    let conn = state.db.lock().unwrap();
    db::set_setting(
        &conn,
        "auto_delete_audio",
        if settings.auto_delete_audio { "true" } else { "false" },
    )
    .map_err(map_err)?;
    db::set_setting(
        &conn,
        "recordings_dir",
        settings.recordings_dir.as_deref().unwrap_or(""),
    )
    .map_err(map_err)?;
    db::set_setting(
        &conn,
        "selected_device",
        settings.selected_device.as_deref().unwrap_or(""),
    )
    .map_err(map_err)?;
    db::set_setting(&conn, "sort_by", &settings.sort_by).map_err(map_err)?;
    db::set_setting(
        &conn,
        "default_tag",
        settings.default_tag.as_deref().unwrap_or(""),
    )
    .map_err(map_err)?;
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
    let data = data_dir(&app).map_err(map_err)?;
    let (dir, device_name) = {
        let conn = state.db.lock().unwrap();
        let dir = recordings_dir_resolved(&data, &conn).map_err(map_err)?;
        let device_name = db::get_setting(&conn, "selected_device")
            .ok()
            .flatten()
            .filter(|s| !s.is_empty());
        (dir, device_name)
    };

    let timestamp = chrono::Local::now().format("%Y-%m-%d_%H-%M-%S").to_string();
    let path = dir.join(format!("{timestamp}.wav"));

    audio.start(path.clone(), device_name).await.map_err(map_err)?;

    *state.current_recording_path.lock().unwrap() = Some(path.clone());

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

            let src = {
                let s = app2.state::<AppState>();
                let p = s.current_recording_path.lock().unwrap().clone();
                p
            };
            let Some(src) = src else { break };

            let tmp = src.with_extension("snap.wav");
            if std::fs::copy(&src, &tmp).is_err() {
                continue;
            }
            if fix_wav_header(&tmp).is_err() {
                let _ = std::fs::remove_file(&tmp);
                continue;
            }

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
    if let Some(tx) = state.live_stop.lock().unwrap().take() {
        let _ = tx.send(());
    }
    *state.current_recording_path.lock().unwrap() = None;

    let path = audio.stop().await.map_err(map_err)?;
    Ok(path.to_string_lossy().to_string())
}

// ---- Audio devices / level --------------------------------------------------

#[tauri::command]
pub async fn list_audio_devices(audio: State<'_, AudioHandle>) -> Result<Vec<String>, String> {
    Ok(audio.list_devices().await)
}

#[tauri::command]
pub async fn get_audio_level(audio: State<'_, AudioHandle>) -> Result<f32, String> {
    Ok(audio.get_level())
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

    let summary =
        generate_summary_inner(&app, &state, &meeting_id, &full_text, None)
            .await
            .map_err(map_err)?;

    // Auto-delete audio if enabled
    {
        let conn = state.db.lock().unwrap();
        let auto_delete = db::get_setting(&conn, "auto_delete_audio")
            .ok()
            .flatten()
            .as_deref()
            == Some("true");
        if auto_delete && !args.audio_path.is_empty() {
            let _ = std::fs::remove_file(&args.audio_path);
        }
    }

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
        // insert_summary already updates active_summary_version
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

// ---- Import audio file -----------------------------------------------------

#[tauri::command]
pub async fn import_audio_file(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<MeetingResult, String> {
    if !state.asr.is_ready().await {
        return Err("ASR model is still loading. Please wait.".to_string());
    }

    let src = std::path::PathBuf::from(&path);
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    // Convert to WAV if needed
    let (wav_path, is_temp) = if ext == "wav" {
        (src.clone(), false)
    } else {
        let data = data_dir(&app).map_err(map_err)?;
        let out = data
            .join("recordings")
            .join(format!("import_{}.wav", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(out.parent().unwrap()).map_err(map_err)?;
        let out_str = out.to_string_lossy().to_string();
        let status = tokio::process::Command::new("ffmpeg")
            .env("PATH", "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin")
            .args(["-i", &path, "-ar", "16000", "-ac", "1", "-y", &out_str])
            .status()
            .await
            .map_err(|e| format!("ffmpeg not found ({e}). Install with: brew install ffmpeg"))?;
        if !status.success() {
            return Err(
                "Audio conversion failed. Make sure ffmpeg is installed.".to_string(),
            );
        }
        (out, true)
    };

    let transcript = state.asr.transcribe(&wav_path).await.map_err(map_err)?;
    let full_text = transcript.full_text.clone();
    let duration = transcript.segments.last().map(|s| s.end);

    if is_temp {
        let _ = std::fs::remove_file(&wav_path);
    }

    let file_name = src
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Import");
    let title = format!("Import — {}", file_name);
    let meeting_id = uuid::Uuid::new_v4().to_string();

    {
        let conn = state.db.lock().unwrap();
        db::insert_meeting(&conn, &meeting_id, &title, &path, &full_text, duration)
            .map_err(map_err)?;
        let segs: Vec<(f64, f64, &str)> = transcript
            .segments
            .iter()
            .map(|s| (s.start, s.end, s.text.as_str()))
            .collect();
        db::insert_transcript_segments(&conn, &meeting_id, &segs).map_err(map_err)?;
    }

    let summary =
        generate_summary_inner(&app, &state, &meeting_id, &full_text, None)
            .await
            .map_err(map_err)?;

    let llm = state.llm.clone();
    let mid = meeting_id.clone();
    let excerpt = full_text.chars().take(2000).collect::<String>();
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        let msgs = context_file::build_title_messages(&excerpt);
        if let Ok(t) = llm.chat(msgs).await {
            let t = t.trim().trim_matches('"').to_string();
            let s = app2.state::<AppState>();
            let conn = s.db.lock().unwrap();
            let _ = db::update_meeting_title(&conn, &mid, &t);
            drop(conn);
            let _ = app2.emit("meeting-title-ready", (&mid, &t));
        }
    });

    Ok(MeetingResult { meeting_id, summary })
}

// ---- Phase 2: Meetings list & detail ---------------------------------------

#[derive(Serialize)]
pub struct MeetingListItem {
    pub id: String,
    pub title: String,
    pub folder_id: Option<String>,
    pub created_at: String,
    pub duration_seconds: Option<f64>,
    pub is_pinned: bool,
    pub deleted_at: Option<String>,
    pub tags: Vec<UserTagItem>,
}

#[tauri::command]
pub async fn list_meetings(
    state: State<'_, AppState>,
    search: Option<String>,
    folder_id: Option<String>,
    sort_by: Option<String>,
) -> Result<Vec<MeetingListItem>, String> {
    let conn = state.db.lock().unwrap();
    let rows = db::list_meetings(
        &conn,
        search.as_deref(),
        folder_id.as_deref(),
        sort_by.as_deref().unwrap_or("date_desc"),
    )
    .map_err(map_err)?;
    let mut tag_map = db::get_all_meeting_tags(&conn).map_err(map_err)?;
    Ok(rows
        .into_iter()
        .map(|r| {
            let tags = tag_map
                .remove(&r.id)
                .unwrap_or_default()
                .into_iter()
                .map(|t| UserTagItem { id: t.id, name: t.name, color: t.color })
                .collect();
            MeetingListItem {
                id: r.id,
                title: r.title,
                folder_id: r.folder_id,
                created_at: r.created_at,
                duration_seconds: r.duration_seconds,
                is_pinned: r.is_pinned,
                deleted_at: r.deleted_at,
                tags,
            }
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

#[derive(Serialize, Deserialize, Clone)]
pub struct ActionItemResponse {
    pub text: String,
    pub done: bool,
}

#[derive(Serialize)]
pub struct LinkedMeetingItem {
    pub id: String,
    pub title: String,
    pub created_at: String,
}

#[derive(Serialize)]
pub struct MeetingDetail {
    pub id: String,
    pub title: String,
    pub folder_id: Option<String>,
    pub created_at: String,
    pub duration_seconds: Option<f64>,
    pub audio_path: Option<String>,
    pub active_summary_version: Option<i64>,
    pub is_pinned: bool,
    pub segments: Vec<TranscriptSegmentItem>,
    pub notes: Vec<NoteItem>,
    pub summaries: Vec<SummaryVersionItem>,
    pub chat_messages: Vec<StoredChatMessage>,
    pub tags: Vec<UserTagItem>,
    pub notes_content: Option<String>,
    pub action_items: Vec<ActionItemResponse>,
    pub linked_notes: Vec<NoteFileItem>,
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

    let tags = db::get_meeting_tags(&conn, &meeting_id)
        .map_err(map_err)?
        .into_iter()
        .map(|t| UserTagItem { id: t.id, name: t.name, color: t.color })
        .collect();

    let notes_content = db::get_notes_content(&conn, &meeting_id).map_err(map_err)?;

    let action_items: Vec<ActionItemResponse> = db::get_action_items(&conn, &meeting_id)
        .map_err(map_err)?
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_default();

    let linked_notes = db::get_meeting_linked_notes(&conn, &meeting_id)
        .map_err(map_err)?
        .into_iter()
        .map(note_item)
        .collect();

    Ok(MeetingDetail {
        id: row.id,
        title: row.title,
        folder_id: row.folder_id,
        created_at: row.created_at,
        duration_seconds: row.duration_seconds,
        audio_path: row.audio_path,
        active_summary_version: row.active_summary_version,
        is_pinned: row.is_pinned,
        segments,
        notes,
        summaries,
        chat_messages,
        tags,
        notes_content,
        action_items,
        linked_notes,
    })
}

#[derive(Deserialize)]
pub struct UpdateMeetingArgs {
    pub id: String,
    pub title: Option<String>,
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
    Ok(())
}

#[tauri::command]
pub async fn assign_meeting_folder(
    state: State<'_, AppState>,
    meeting_id: String,
    folder_id: Option<String>,
) -> Result<(), String> {
    let conn = state.db.lock().unwrap();
    db::update_meeting_folder(&conn, &meeting_id, folder_id.as_deref()).map_err(map_err)
}

#[tauri::command]
pub async fn delete_meeting(
    state: State<'_, AppState>,
    meeting_id: String,
) -> Result<(), String> {
    let conn = state.db.lock().unwrap();
    db::delete_meeting(&conn, &meeting_id).map_err(map_err)
}

#[tauri::command]
pub async fn list_trashed_meetings(
    state: State<'_, AppState>,
) -> Result<Vec<MeetingListItem>, String> {
    let conn = state.db.lock().unwrap();
    let rows = db::list_trashed_meetings(&conn).map_err(map_err)?;
    let mut tag_map = db::get_all_meeting_tags(&conn).map_err(map_err)?;
    Ok(rows
        .into_iter()
        .map(|r| {
            let tags = tag_map
                .remove(&r.id)
                .unwrap_or_default()
                .into_iter()
                .map(|t| UserTagItem { id: t.id, name: t.name, color: t.color })
                .collect();
            MeetingListItem {
                id: r.id,
                title: r.title,
                folder_id: r.folder_id,
                created_at: r.created_at,
                duration_seconds: r.duration_seconds,
                is_pinned: r.is_pinned,
                deleted_at: r.deleted_at,
                tags,
            }
        })
        .collect())
}

#[tauri::command]
pub async fn restore_meeting(
    state: State<'_, AppState>,
    meeting_id: String,
) -> Result<(), String> {
    let conn = state.db.lock().unwrap();
    db::restore_meeting(&conn, &meeting_id).map_err(map_err)
}

#[tauri::command]
pub async fn permanently_delete_meeting(
    state: State<'_, AppState>,
    meeting_id: String,
) -> Result<(), String> {
    let audio_path = {
        let conn = state.db.lock().unwrap();
        db::permanently_delete_meeting(&conn, &meeting_id).map_err(map_err)?
    };
    if let Some(path) = audio_path {
        let _ = std::fs::remove_file(&path);
    }
    Ok(())
}

#[tauri::command]
pub async fn toggle_pin_meeting(
    state: State<'_, AppState>,
    meeting_id: String,
    pinned: bool,
) -> Result<(), String> {
    let conn = state.db.lock().unwrap();
    db::toggle_pin_meeting(&conn, &meeting_id, pinned).map_err(map_err)
}

#[tauri::command]
pub async fn set_meeting_color(
    state: State<'_, AppState>,
    meeting_id: String,
    color: Option<String>,
) -> Result<(), String> {
    let conn = state.db.lock().unwrap();
    db::set_meeting_color(&conn, &meeting_id, color.as_deref()).map_err(map_err)
}

// ---- Summary version history -----------------------------------------------

#[tauri::command]
pub async fn restore_summary(
    state: State<'_, AppState>,
    meeting_id: String,
    version: i64,
) -> Result<String, String> {
    let conn = state.db.lock().unwrap();

    let content = db::get_summaries(&conn, &meeting_id)
        .map_err(map_err)?
        .into_iter()
        .find(|s| s.version == version)
        .map(|s| s.content)
        .ok_or_else(|| "Summary version not found".to_string())?;

    // Just update the active version pointer — no new row created
    db::set_active_summary_version(&conn, &meeting_id, version).map_err(map_err)?;

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

// ---- Standalone notes ------------------------------------------------------

#[derive(Serialize)]
pub struct NoteFileItem {
    pub id: String,
    pub title: String,
    pub content: String,
    pub folder_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

fn note_item(r: db::NoteFileRow) -> NoteFileItem {
    NoteFileItem { id: r.id, title: r.title, content: r.content, folder_id: r.folder_id, created_at: r.created_at, updated_at: r.updated_at }
}

#[tauri::command]
pub async fn list_notes(
    state: State<'_, AppState>,
    search: Option<String>,
    folder_id: Option<String>,
) -> Result<Vec<NoteFileItem>, String> {
    let conn = state.db.lock().unwrap();
    let rows = db::list_note_files(&conn, search.as_deref(), folder_id.as_deref()).map_err(map_err)?;
    Ok(rows.into_iter().map(note_item).collect())
}

#[tauri::command]
pub async fn get_note(state: State<'_, AppState>, note_id: String) -> Result<Option<NoteFileItem>, String> {
    let conn = state.db.lock().unwrap();
    Ok(db::get_note_file(&conn, &note_id).map_err(map_err)?.map(note_item))
}

#[tauri::command]
pub async fn create_note(state: State<'_, AppState>) -> Result<NoteFileItem, String> {
    let conn = state.db.lock().unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let row = db::insert_note_file(&conn, &id).map_err(map_err)?;
    Ok(note_item(row))
}

#[tauri::command]
pub async fn assign_note_folder(
    state: State<'_, AppState>,
    note_id: String,
    folder_id: Option<String>,
) -> Result<(), String> {
    let conn = state.db.lock().unwrap();
    db::update_note_file_folder(&conn, &note_id, folder_id.as_deref()).map_err(map_err)
}

#[derive(Deserialize)]
pub struct SaveNoteArgs {
    pub note_id: String,
    pub title: Option<String>,
    pub content: Option<String>,
}

#[tauri::command]
pub async fn save_note(state: State<'_, AppState>, args: SaveNoteArgs) -> Result<(), String> {
    let conn = state.db.lock().unwrap();
    if let Some(t) = &args.title {
        db::update_note_file_title(&conn, &args.note_id, t).map_err(map_err)?;
    }
    if let Some(c) = &args.content {
        db::update_note_file_content(&conn, &args.note_id, c).map_err(map_err)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn delete_note(state: State<'_, AppState>, note_id: String) -> Result<(), String> {
    let conn = state.db.lock().unwrap();
    db::delete_note_file(&conn, &note_id).map_err(map_err)
}

#[tauri::command]
pub async fn delete_note_if_empty(
    state: State<'_, AppState>,
    note_id: String,
) -> Result<bool, String> {
    let conn = state.db.lock().unwrap();
    let deleted = db::delete_note_file_if_empty(&conn, &note_id).map_err(map_err)?;
    Ok(deleted)
}

// ---- Action items ----------------------------------------------------------

#[tauri::command]
pub async fn extract_action_items(
    state: State<'_, AppState>,
    meeting_id: String,
) -> Result<Vec<ActionItemResponse>, String> {
    let full_text = {
        let conn = state.db.lock().unwrap();
        db::get_full_text(&conn, &meeting_id)
            .map_err(map_err)?
            .ok_or_else(|| "Meeting not found".to_string())?
    };
    if full_text.trim().is_empty() {
        return Ok(vec![]);
    }
    let messages = context_file::build_action_items_messages(&full_text);
    let raw = state.llm.chat(messages).await.map_err(map_err)?;
    let items: Vec<ActionItemResponse> = raw
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .map(|l| {
            let text = l
                .trim_start_matches("- ")
                .trim_start_matches("* ")
                .trim_start_matches("• ")
                .trim()
                .to_string();
            ActionItemResponse { text, done: false }
        })
        .filter(|a| !a.text.is_empty())
        .collect();
    let json = serde_json::to_string(&items).map_err(map_err)?;
    let conn = state.db.lock().unwrap();
    db::save_action_items(&conn, &meeting_id, &json).map_err(map_err)?;
    Ok(items)
}

#[derive(Deserialize)]
pub struct SaveActionItemsArgs {
    pub meeting_id: String,
    pub items: Vec<ActionItemResponse>,
}

#[tauri::command]
pub async fn save_action_items(
    state: State<'_, AppState>,
    args: SaveActionItemsArgs,
) -> Result<(), String> {
    let json = serde_json::to_string(&args.items).map_err(map_err)?;
    let conn = state.db.lock().unwrap();
    db::save_action_items(&conn, &args.meeting_id, &json).map_err(map_err)
}

// ---- Note-meeting links ----------------------------------------------------

#[tauri::command]
pub async fn link_note_to_meeting(
    state: State<'_, AppState>,
    note_id: String,
    meeting_id: String,
) -> Result<(), String> {
    let conn = state.db.lock().unwrap();
    db::link_note_meeting(&conn, &note_id, &meeting_id).map_err(map_err)
}

#[tauri::command]
pub async fn unlink_note_from_meeting(
    state: State<'_, AppState>,
    note_id: String,
    meeting_id: String,
) -> Result<(), String> {
    let conn = state.db.lock().unwrap();
    db::unlink_note_meeting(&conn, &note_id, &meeting_id).map_err(map_err)
}

#[tauri::command]
pub async fn get_note_linked_meetings(
    state: State<'_, AppState>,
    note_id: String,
) -> Result<Vec<LinkedMeetingItem>, String> {
    let conn = state.db.lock().unwrap();
    let rows = db::get_note_linked_meetings(&conn, &note_id).map_err(map_err)?;
    Ok(rows
        .into_iter()
        .map(|r| LinkedMeetingItem { id: r.id, title: r.title, created_at: r.created_at })
        .collect())
}

// ---- Rich notes (per-meeting) ----------------------------------------------

#[tauri::command]
pub async fn save_meeting_notes(
    state: State<'_, AppState>,
    meeting_id: String,
    content: String,
) -> Result<(), String> {
    let conn = state.db.lock().unwrap();
    db::save_notes_content(&conn, &meeting_id, &content).map_err(map_err)
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
    let active_version = row.active_summary_version;
    let latest_summary = if let Some(av) = active_version {
        summaries.iter().find(|s| s.version == av).map(|s| s.content.as_str())
            .or_else(|| summaries.first().map(|s| s.content.as_str()))
    } else {
        summaries.first().map(|s| s.content.as_str())
    };

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

    let tags = db::get_meeting_tags(&conn, &meeting_id).map_err(map_err)?;
    let tags_str = tags.iter().map(|t| t.name.as_str()).collect::<Vec<_>>().join(", ");
    let subject = if tags_str.is_empty() { None } else { Some(tags_str.as_str()) };

    let rich_notes = db::get_notes_content(&conn, &meeting_id).map_err(map_err)?;

    let md = context_file::build_markdown_export(
        &row.title,
        subject,
        &row.created_at,
        row.duration_seconds,
        latest_summary,
        &segments,
        &notes,
        rich_notes.as_deref(),
    );

    Ok(md)
}

// ---- Write file ------------------------------------------------------------

#[tauri::command]
pub async fn write_text_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| e.to_string())
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

// ---- Standalone chat -------------------------------------------------------

#[derive(Deserialize)]
pub struct HistoryMessage {
    pub role: String,
    pub content: String,
}

#[derive(Deserialize)]
pub struct StandaloneChatArgs {
    pub message: String,
    pub meeting_ids: Vec<String>,
    pub history: Vec<HistoryMessage>,
}

#[tauri::command]
pub async fn send_standalone_chat(
    app: AppHandle,
    state: State<'_, AppState>,
    args: StandaloneChatArgs,
) -> Result<ChatResponse, String> {
    let data_dir = data_dir(&app).map_err(map_err)?;
    let context_md = context_file::load_context(&data_dir);

    let transcripts: Vec<(String, String)> = {
        let conn = state.db.lock().unwrap();
        args.meeting_ids
            .iter()
            .filter_map(|id| db::get_meeting_title_and_text(&conn, id).ok().flatten())
            .collect()
    };

    let system_msg =
        context_file::build_standalone_chat_system_message(&transcripts, &context_md);
    let mut messages = vec![system_msg];
    for h in &args.history {
        messages.push(ChatMessage { role: h.role.clone(), content: h.content.clone() });
    }
    messages.push(ChatMessage::user(args.message.clone()));

    let on_chunk = Arc::new({
        let app = app.clone();
        move |chunk: String| {
            let _ = app.emit("standalone-chat-chunk", chunk);
        }
    });

    let response = state.llm.chat_streaming(messages, on_chunk).await.map_err(map_err)?;

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

// ---- Folders ---------------------------------------------------------------

#[derive(Serialize)]
pub struct FolderItem {
    pub id: String,
    pub name: String,
    pub color: String,
    pub created_at: String,
}

#[tauri::command]
pub async fn list_folders(state: State<'_, AppState>) -> Result<Vec<FolderItem>, String> {
    let conn = state.db.lock().unwrap();
    db::list_folders(&conn)
        .map_err(map_err)
        .map(|rows| {
            rows.into_iter()
                .map(|r| FolderItem { id: r.id, name: r.name, color: r.color, created_at: r.created_at })
                .collect()
        })
}

#[derive(Deserialize)]
pub struct CreateFolderArgs {
    pub name: String,
    pub color: String,
}

#[tauri::command]
pub async fn create_folder(
    state: State<'_, AppState>,
    args: CreateFolderArgs,
) -> Result<FolderItem, String> {
    let conn = state.db.lock().unwrap();
    let row = db::insert_folder(&conn, &args.name, &args.color).map_err(map_err)?;
    Ok(FolderItem { id: row.id, name: row.name, color: row.color, created_at: row.created_at })
}

#[tauri::command]
pub async fn delete_folder(
    state: State<'_, AppState>,
    folder_id: String,
) -> Result<(), String> {
    let conn = state.db.lock().unwrap();
    db::delete_folder(&conn, &folder_id).map_err(map_err)
}

#[derive(Deserialize)]
pub struct RenameFolderArgs {
    pub id: String,
    pub name: String,
}

#[tauri::command]
pub async fn rename_folder(
    state: State<'_, AppState>,
    args: RenameFolderArgs,
) -> Result<(), String> {
    let conn = state.db.lock().unwrap();
    db::rename_folder(&conn, &args.id, &args.name).map_err(map_err)
}

// ---- User tags -------------------------------------------------------------

#[derive(Serialize)]
pub struct UserTagItem {
    pub id: String,
    pub name: String,
    pub color: String,
}

#[tauri::command]
pub async fn list_tags(state: State<'_, AppState>) -> Result<Vec<UserTagItem>, String> {
    let conn = state.db.lock().unwrap();
    db::list_user_tags(&conn)
        .map_err(map_err)
        .map(|rows| {
            rows.into_iter()
                .map(|r| UserTagItem { id: r.id, name: r.name, color: r.color })
                .collect()
        })
}

#[derive(Deserialize)]
pub struct CreateTagArgs {
    pub name: String,
    pub color: String,
}

#[tauri::command]
pub async fn create_tag(
    state: State<'_, AppState>,
    args: CreateTagArgs,
) -> Result<UserTagItem, String> {
    let conn = state.db.lock().unwrap();
    let row = db::insert_user_tag(&conn, &args.name, &args.color).map_err(map_err)?;
    Ok(UserTagItem { id: row.id, name: row.name, color: row.color })
}

#[tauri::command]
pub async fn delete_tag(
    state: State<'_, AppState>,
    tag_id: String,
) -> Result<(), String> {
    let conn = state.db.lock().unwrap();
    db::delete_user_tag(&conn, &tag_id).map_err(map_err)
}

#[tauri::command]
pub async fn set_meeting_tags(
    state: State<'_, AppState>,
    meeting_id: String,
    tag_ids: Vec<String>,
) -> Result<(), String> {
    let conn = state.db.lock().unwrap();
    db::set_meeting_tags(&conn, &meeting_id, &tag_ids).map_err(map_err)
}

// Suppress unused warning for the original helper (kept for reference)
#[allow(dead_code)]
fn _recordings_dir_orig(app: &AppHandle) -> Result<PathBuf> {
    recordings_dir(app)
}
