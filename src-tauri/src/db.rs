use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};

pub fn init(conn: &Connection) -> Result<()> {
    // Safe migrations for pre-existing columns
    let _ = conn.execute_batch(
        "ALTER TABLE manual_notes ADD COLUMN elapsed_seconds REAL NOT NULL DEFAULT 0;",
    );
    let _ = conn.execute_batch("ALTER TABLE meetings ADD COLUMN folder_id TEXT;");
    let _ = conn.execute_batch("ALTER TABLE meetings ADD COLUMN active_summary_version INTEGER;");
    let _ = conn.execute_batch("ALTER TABLE meetings ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0;");
    let _ = conn.execute_batch("ALTER TABLE meetings ADD COLUMN color TEXT;");
    let _ = conn.execute_batch("ALTER TABLE meetings ADD COLUMN deleted_at TEXT;");
    let _ = conn.execute_batch("ALTER TABLE meetings ADD COLUMN notes_content TEXT;");
    // Standalone notes table (idempotent via CREATE IF NOT EXISTS)
    let _ = conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS notes (
             id         TEXT PRIMARY KEY,
             title      TEXT NOT NULL DEFAULT 'Untitled Note',
             content    TEXT NOT NULL DEFAULT '',
             folder_id  TEXT,
             created_at TEXT NOT NULL,
             updated_at TEXT NOT NULL
         );"
    );
    let _ = conn.execute_batch("ALTER TABLE notes ADD COLUMN folder_id TEXT;");
    let _ = conn.execute_batch("ALTER TABLE meetings ADD COLUMN action_items TEXT;");
    let _ = conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS note_meetings (
             note_id    TEXT NOT NULL,
             meeting_id TEXT NOT NULL,
             created_at TEXT NOT NULL DEFAULT (datetime('now')),
             PRIMARY KEY (note_id, meeting_id)
         );"
    );
    let _ = conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
    );

    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
         PRAGMA foreign_keys=ON;

         CREATE TABLE IF NOT EXISTS meetings (
             id          TEXT PRIMARY KEY,
             title       TEXT NOT NULL,
             subject_tag TEXT,
             created_at  TEXT NOT NULL,
             duration_seconds REAL,
             audio_path  TEXT,
             full_text   TEXT NOT NULL DEFAULT '',
             folder_id   TEXT,
             active_summary_version INTEGER,
             is_pinned   INTEGER NOT NULL DEFAULT 0,
             color       TEXT
         );

         CREATE TABLE IF NOT EXISTS transcript_segments (
             id          TEXT PRIMARY KEY,
             meeting_id  TEXT NOT NULL,
             start_time  REAL NOT NULL,
             end_time    REAL NOT NULL,
             text        TEXT NOT NULL,
             FOREIGN KEY (meeting_id) REFERENCES meetings(id)
         );

         CREATE TABLE IF NOT EXISTS manual_notes (
             id               TEXT PRIMARY KEY,
             meeting_id       TEXT NOT NULL,
             timestamp        TEXT NOT NULL,
             elapsed_seconds  REAL NOT NULL DEFAULT 0,
             text             TEXT NOT NULL,
             FOREIGN KEY (meeting_id) REFERENCES meetings(id)
         );

         CREATE TABLE IF NOT EXISTS summaries (
             id          TEXT PRIMARY KEY,
             meeting_id  TEXT NOT NULL,
             version     INTEGER NOT NULL,
             content     TEXT NOT NULL,
             created_at  TEXT NOT NULL,
             FOREIGN KEY (meeting_id) REFERENCES meetings(id)
         );

         CREATE TABLE IF NOT EXISTS chat_messages (
             id          TEXT PRIMARY KEY,
             meeting_id  TEXT NOT NULL,
             role        TEXT NOT NULL,
             content     TEXT NOT NULL,
             created_at  TEXT NOT NULL,
             FOREIGN KEY (meeting_id) REFERENCES meetings(id)
         );

         CREATE TABLE IF NOT EXISTS folders (
             id         TEXT PRIMARY KEY,
             name       TEXT NOT NULL,
             color      TEXT NOT NULL DEFAULT '#6366f1',
             created_at TEXT NOT NULL
         );

         CREATE TABLE IF NOT EXISTS user_tags (
             id         TEXT PRIMARY KEY,
             name       TEXT NOT NULL UNIQUE,
             color      TEXT NOT NULL DEFAULT '#6b7280',
             created_at TEXT NOT NULL
         );

         CREATE TABLE IF NOT EXISTS settings (
             key   TEXT PRIMARY KEY,
             value TEXT NOT NULL
         );",
    )?;

    // meeting_tags join table (many-to-many, idempotent)
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS meeting_tags (
             meeting_id TEXT NOT NULL,
             tag_id     TEXT NOT NULL,
             PRIMARY KEY (meeting_id, tag_id),
             FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE,
             FOREIGN KEY (tag_id)     REFERENCES user_tags(id) ON DELETE CASCADE
         );"
    )?;

    // Migrate any existing subject_tag string → meeting_tags rows (idempotent)
    conn.execute_batch(
        "INSERT OR IGNORE INTO meeting_tags (meeting_id, tag_id)
         SELECT m.id, ut.id
         FROM meetings m
         JOIN user_tags ut ON ut.name = m.subject_tag
         WHERE m.subject_tag IS NOT NULL;"
    )?;

    // Seed preset IB tags (idempotent via UNIQUE name constraint)
    let presets = [
        ("HL",         "#8b5cf6"),
        ("SL",         "#3b82f6"),
        ("Paper 1",    "#22c55e"),
        ("Paper 2",    "#f97316"),
        ("Paper 3",    "#ef4444"),
        ("Past Paper", "#ec4899"),
        ("Review",     "#14b8a6"),
    ];
    for (name, color) in &presets {
        let id = uuid::Uuid::new_v4().to_string();
        let _ = conn.execute(
            "INSERT OR IGNORE INTO user_tags (id, name, color, created_at) VALUES (?1, ?2, ?3, datetime('now'))",
            params![id, name, color],
        );
    }

    Ok(())
}

// --- Meetings ---

pub fn insert_meeting(
    conn: &Connection,
    id: &str,
    title: &str,
    audio_path: &str,
    full_text: &str,
    duration_seconds: Option<f64>,
) -> Result<()> {
    conn.execute(
        "INSERT INTO meetings (id, title, created_at, audio_path, full_text, duration_seconds)
         VALUES (?1, ?2, datetime('now'), ?3, ?4, ?5)",
        params![id, title, audio_path, full_text, duration_seconds],
    )?;
    Ok(())
}

pub fn insert_transcript_segments(
    conn: &Connection,
    meeting_id: &str,
    segments: &[(f64, f64, &str)],
) -> Result<()> {
    for (start, end, text) in segments {
        let seg_id = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO transcript_segments (id, meeting_id, start_time, end_time, text)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![seg_id, meeting_id, start, end, text],
        )?;
    }
    Ok(())
}

// --- Summaries ---

pub fn next_summary_version(conn: &Connection, meeting_id: &str) -> Result<i64> {
    let version: i64 = conn.query_row(
        "SELECT COALESCE(MAX(version), 0) + 1 FROM summaries WHERE meeting_id = ?1",
        params![meeting_id],
        |row| row.get(0),
    )?;
    Ok(version)
}

pub fn insert_summary(
    conn: &Connection,
    meeting_id: &str,
    version: i64,
    content: &str,
) -> Result<String> {
    let id = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO summaries (id, meeting_id, version, content, created_at)
         VALUES (?1, ?2, ?3, ?4, datetime('now'))",
        params![id, meeting_id, version, content],
    )?;
    // Update active version whenever a new summary is created
    conn.execute(
        "UPDATE meetings SET active_summary_version = ?1 WHERE id = ?2",
        params![version, meeting_id],
    )?;
    Ok(id)
}

pub fn set_active_summary_version(conn: &Connection, meeting_id: &str, version: i64) -> Result<()> {
    conn.execute(
        "UPDATE meetings SET active_summary_version = ?1 WHERE id = ?2",
        params![version, meeting_id],
    )?;
    Ok(())
}

pub fn get_latest_summary(conn: &Connection, meeting_id: &str) -> Result<Option<String>> {
    let mut stmt = conn.prepare(
        "SELECT content FROM summaries WHERE meeting_id = ?1
         ORDER BY version DESC LIMIT 1",
    )?;
    let result = stmt
        .query_row(params![meeting_id], |row| row.get(0))
        .optional()?;
    Ok(result)
}

// --- Chat messages ---

pub fn insert_chat_message(
    conn: &Connection,
    meeting_id: &str,
    role: &str,
    content: &str,
) -> Result<()> {
    let id = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO chat_messages (id, meeting_id, role, content, created_at)
         VALUES (?1, ?2, ?3, ?4, datetime('now'))",
        params![id, meeting_id, role, content],
    )?;
    Ok(())
}

pub fn get_chat_history(
    conn: &Connection,
    meeting_id: &str,
) -> Result<Vec<(String, String)>> {
    let mut stmt = conn.prepare(
        "SELECT role, content FROM chat_messages
         WHERE meeting_id = ?1
         ORDER BY created_at ASC",
    )?;
    let rows = stmt
        .query_map(params![meeting_id], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

// --- Full transcript text ---

pub fn get_meeting_title_and_text(
    conn: &Connection,
    meeting_id: &str,
) -> Result<Option<(String, String)>> {
    let mut stmt =
        conn.prepare("SELECT title, full_text FROM meetings WHERE id = ?1")?;
    let result = stmt
        .query_row(params![meeting_id], |row| Ok((row.get(0)?, row.get(1)?)))
        .optional()?;
    Ok(result)
}

pub fn get_full_text(conn: &Connection, meeting_id: &str) -> Result<Option<String>> {
    let mut stmt =
        conn.prepare("SELECT full_text FROM meetings WHERE id = ?1")?;
    let result = stmt
        .query_row(params![meeting_id], |row| row.get(0))
        .optional()?;
    Ok(result)
}

// ===== Phase 2 additions =====

pub struct MeetingRow {
    pub id: String,
    pub title: String,
    pub subject_tag: Option<String>,
    pub folder_id: Option<String>,
    pub created_at: String,
    pub duration_seconds: Option<f64>,
    pub audio_path: Option<String>,
    pub active_summary_version: Option<i64>,
    pub is_pinned: bool,
    pub color: Option<String>,
    pub deleted_at: Option<String>,
}

pub struct SummaryRow {
    pub version: i64,
    pub content: String,
    pub created_at: String,
}

pub struct NoteRow {
    pub id: String,
    pub elapsed_seconds: f64,
    pub text: String,
}

pub struct FolderRow {
    pub id: String,
    pub name: String,
    pub color: String,
    pub created_at: String,
}

pub struct UserTagRow {
    pub id: String,
    pub name: String,
    pub color: String,
}

fn sort_clause(sort_by: &str) -> &'static str {
    match sort_by {
        "date_asc" => "ORDER BY is_pinned DESC, created_at ASC",
        "duration_desc" => "ORDER BY is_pinned DESC, duration_seconds DESC NULLS LAST",
        "duration_asc" => "ORDER BY is_pinned DESC, duration_seconds ASC NULLS LAST",
        "title_asc" => "ORDER BY is_pinned DESC, title ASC",
        "title_desc" => "ORDER BY is_pinned DESC, title DESC",
        _ => "ORDER BY is_pinned DESC, created_at DESC",
    }
}

pub fn list_meetings(
    conn: &Connection,
    search: Option<&str>,
    folder_id: Option<&str>,
    sort_by: &str,
) -> Result<Vec<MeetingRow>> {
    let pattern = search
        .filter(|s| !s.is_empty())
        .map(|q| format!("%{q}%"));

    let order = sort_clause(sort_by);

    let rows: Vec<MeetingRow> = match (pattern.as_deref(), folder_id) {
        (Some(p), Some(fid)) => {
            let sql = format!(
                "SELECT id, title, subject_tag, created_at, duration_seconds, audio_path, folder_id, active_summary_version, is_pinned, color, deleted_at \
                 FROM meetings WHERE deleted_at IS NULL AND folder_id = ?1 AND (title LIKE ?2 OR full_text LIKE ?2) {order}"
            );
            let mut stmt = conn.prepare(&sql)?;
            let r = stmt.query_map(params![fid, p], row_to_meeting)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            r
        }
        (Some(p), None) => {
            let sql = format!(
                "SELECT id, title, subject_tag, created_at, duration_seconds, audio_path, folder_id, active_summary_version, is_pinned, color, deleted_at \
                 FROM meetings WHERE deleted_at IS NULL AND (title LIKE ?1 OR full_text LIKE ?1) {order}"
            );
            let mut stmt = conn.prepare(&sql)?;
            let r = stmt.query_map(params![p], row_to_meeting)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            r
        }
        (None, Some(fid)) => {
            let sql = format!(
                "SELECT id, title, subject_tag, created_at, duration_seconds, audio_path, folder_id, active_summary_version, is_pinned, color, deleted_at \
                 FROM meetings WHERE deleted_at IS NULL AND folder_id = ?1 {order}"
            );
            let mut stmt = conn.prepare(&sql)?;
            let r = stmt.query_map(params![fid], row_to_meeting)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            r
        }
        (None, None) => {
            let sql = format!(
                "SELECT id, title, subject_tag, created_at, duration_seconds, audio_path, folder_id, active_summary_version, is_pinned, color, deleted_at \
                 FROM meetings WHERE deleted_at IS NULL {order}"
            );
            let mut stmt = conn.prepare(&sql)?;
            let r = stmt.query_map([], row_to_meeting)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            r
        }
    };
    Ok(rows)
}

fn row_to_meeting(row: &rusqlite::Row<'_>) -> rusqlite::Result<MeetingRow> {
    Ok(MeetingRow {
        id: row.get(0)?,
        title: row.get(1)?,
        subject_tag: row.get(2)?,
        created_at: row.get(3)?,
        duration_seconds: row.get(4)?,
        audio_path: row.get(5)?,
        folder_id: row.get(6)?,
        active_summary_version: row.get(7)?,
        is_pinned: row.get::<_, i64>(8)? != 0,
        color: row.get(9)?,
        deleted_at: row.get(10)?,
    })
}

pub fn get_meeting(conn: &Connection, id: &str) -> Result<Option<MeetingRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, title, subject_tag, created_at, duration_seconds, audio_path, folder_id, active_summary_version, is_pinned, color, deleted_at
         FROM meetings WHERE id = ?1",
    )?;
    let result = stmt.query_row(params![id], row_to_meeting).optional()?;
    Ok(result)
}

pub fn get_transcript_segments(
    conn: &Connection,
    meeting_id: &str,
) -> Result<Vec<(f64, f64, String)>> {
    let mut stmt = conn.prepare(
        "SELECT start_time, end_time, text FROM transcript_segments
         WHERE meeting_id = ?1 ORDER BY start_time ASC",
    )?;
    let rows = stmt
        .query_map(params![meeting_id], |row| {
            Ok((row.get::<_, f64>(0)?, row.get::<_, f64>(1)?, row.get::<_, String>(2)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn get_summaries(conn: &Connection, meeting_id: &str) -> Result<Vec<SummaryRow>> {
    let mut stmt = conn.prepare(
        "SELECT version, content, created_at FROM summaries
         WHERE meeting_id = ?1 ORDER BY version DESC",
    )?;
    let rows = stmt
        .query_map(params![meeting_id], |row| {
            Ok(SummaryRow {
                version: row.get(0)?,
                content: row.get(1)?,
                created_at: row.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn get_manual_notes(conn: &Connection, meeting_id: &str) -> Result<Vec<NoteRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, elapsed_seconds, text FROM manual_notes
         WHERE meeting_id = ?1 ORDER BY elapsed_seconds ASC",
    )?;
    let rows = stmt
        .query_map(params![meeting_id], |row| {
            Ok(NoteRow {
                id: row.get(0)?,
                elapsed_seconds: row.get(1)?,
                text: row.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn insert_manual_note(
    conn: &Connection,
    meeting_id: &str,
    elapsed_seconds: f64,
    text: &str,
) -> Result<()> {
    let id = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO manual_notes (id, meeting_id, timestamp, elapsed_seconds, text)
         VALUES (?1, ?2, datetime('now'), ?3, ?4)",
        params![id, meeting_id, elapsed_seconds, text],
    )?;
    Ok(())
}

pub fn update_meeting_title(conn: &Connection, id: &str, title: &str) -> Result<()> {
    conn.execute("UPDATE meetings SET title = ?1 WHERE id = ?2", params![title, id])?;
    Ok(())
}

pub fn update_meeting_subject(conn: &Connection, id: &str, subject: Option<&str>) -> Result<()> {
    conn.execute(
        "UPDATE meetings SET subject_tag = ?1 WHERE id = ?2",
        params![subject, id],
    )?;
    Ok(())
}

pub fn update_meeting_folder(conn: &Connection, id: &str, folder_id: Option<&str>) -> Result<()> {
    conn.execute(
        "UPDATE meetings SET folder_id = ?1 WHERE id = ?2",
        params![folder_id, id],
    )?;
    Ok(())
}

pub fn update_meeting_duration(conn: &Connection, id: &str, duration: f64) -> Result<()> {
    conn.execute(
        "UPDATE meetings SET duration_seconds = ?1 WHERE id = ?2",
        params![duration, id],
    )?;
    Ok(())
}

pub fn delete_meeting(conn: &Connection, id: &str) -> Result<()> {
    let now = chrono::Utc::now().format("%Y-%m-%d %H:%M:%S").to_string();
    conn.execute(
        "UPDATE meetings SET deleted_at = ?1 WHERE id = ?2",
        params![now, id],
    )?;
    Ok(())
}

pub fn list_trashed_meetings(conn: &Connection) -> Result<Vec<MeetingRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, title, subject_tag, created_at, duration_seconds, audio_path, folder_id, active_summary_version, is_pinned, color, deleted_at \
         FROM meetings WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC",
    )?;
    let rows = stmt.query_map([], row_to_meeting)?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn restore_meeting(conn: &Connection, id: &str) -> Result<()> {
    conn.execute(
        "UPDATE meetings SET deleted_at = NULL WHERE id = ?1",
        params![id],
    )?;
    Ok(())
}

pub fn permanently_delete_meeting(conn: &Connection, id: &str) -> Result<Option<String>> {
    let audio_path: Option<String> = conn
        .query_row("SELECT audio_path FROM meetings WHERE id = ?1", params![id], |r| r.get(0))
        .optional()?;
    conn.execute("DELETE FROM chat_messages WHERE meeting_id = ?1", params![id])?;
    conn.execute("DELETE FROM summaries WHERE meeting_id = ?1", params![id])?;
    conn.execute("DELETE FROM manual_notes WHERE meeting_id = ?1", params![id])?;
    conn.execute("DELETE FROM transcript_segments WHERE meeting_id = ?1", params![id])?;
    conn.execute("DELETE FROM meetings WHERE id = ?1", params![id])?;
    Ok(audio_path)
}

pub fn toggle_pin_meeting(conn: &Connection, id: &str, pinned: bool) -> Result<()> {
    conn.execute(
        "UPDATE meetings SET is_pinned = ?1 WHERE id = ?2",
        params![pinned as i64, id],
    )?;
    Ok(())
}

pub fn set_meeting_color(conn: &Connection, id: &str, color: Option<&str>) -> Result<()> {
    conn.execute(
        "UPDATE meetings SET color = ?1 WHERE id = ?2",
        params![color, id],
    )?;
    Ok(())
}

pub fn get_setting(conn: &Connection, key: &str) -> Result<Option<String>> {
    let mut stmt = conn.prepare("SELECT value FROM settings WHERE key = ?1")?;
    let result = stmt.query_row(params![key], |row| row.get(0)).optional()?;
    Ok(result)
}

pub fn set_setting(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
        params![key, value],
    )?;
    Ok(())
}

// --- Folders ---

pub fn insert_folder(conn: &Connection, name: &str, color: &str) -> Result<FolderRow> {
    let id = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO folders (id, name, color, created_at) VALUES (?1, ?2, ?3, datetime('now'))",
        params![id, name, color],
    )?;
    Ok(FolderRow { id, name: name.to_string(), color: color.to_string(), created_at: String::new() })
}

pub fn list_folders(conn: &Connection) -> Result<Vec<FolderRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, color, created_at FROM folders ORDER BY created_at ASC",
    )?;
    let rows = stmt
        .query_map([], |row| {
            Ok(FolderRow {
                id: row.get(0)?,
                name: row.get(1)?,
                color: row.get(2)?,
                created_at: row.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn delete_folder(conn: &Connection, id: &str) -> Result<()> {
    // Un-assign meetings from this folder before deleting
    conn.execute("UPDATE meetings SET folder_id = NULL WHERE folder_id = ?1", params![id])?;
    conn.execute("DELETE FROM folders WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn rename_folder(conn: &Connection, id: &str, name: &str) -> Result<()> {
    conn.execute("UPDATE folders SET name = ?1 WHERE id = ?2", params![name, id])?;
    Ok(())
}

// --- User tags ---

pub fn insert_user_tag(conn: &Connection, name: &str, color: &str) -> Result<UserTagRow> {
    let id = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO user_tags (id, name, color, created_at) VALUES (?1, ?2, ?3, datetime('now'))",
        params![id, name, color],
    )?;
    Ok(UserTagRow { id, name: name.to_string(), color: color.to_string() })
}

pub fn list_user_tags(conn: &Connection) -> Result<Vec<UserTagRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, color FROM user_tags ORDER BY created_at ASC",
    )?;
    let rows = stmt
        .query_map([], |row| {
            Ok(UserTagRow {
                id: row.get(0)?,
                name: row.get(1)?,
                color: row.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn delete_user_tag(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM meeting_tags WHERE tag_id = ?1", params![id])?;
    conn.execute("DELETE FROM user_tags WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn set_meeting_tags(conn: &Connection, meeting_id: &str, tag_ids: &[String]) -> Result<()> {
    conn.execute("DELETE FROM meeting_tags WHERE meeting_id = ?1", params![meeting_id])?;
    for tag_id in tag_ids {
        conn.execute(
            "INSERT OR IGNORE INTO meeting_tags (meeting_id, tag_id) VALUES (?1, ?2)",
            params![meeting_id, tag_id],
        )?;
    }
    Ok(())
}

pub fn get_meeting_tags(conn: &Connection, meeting_id: &str) -> Result<Vec<UserTagRow>> {
    let mut stmt = conn.prepare(
        "SELECT ut.id, ut.name, ut.color FROM user_tags ut
         JOIN meeting_tags mt ON mt.tag_id = ut.id
         WHERE mt.meeting_id = ?1
         ORDER BY ut.created_at ASC",
    )?;
    let rows = stmt
        .query_map(params![meeting_id], |row| {
            Ok(UserTagRow { id: row.get(0)?, name: row.get(1)?, color: row.get(2)? })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

// --- Standalone notes ---

pub struct NoteFileRow {
    pub id: String,
    pub title: String,
    pub content: String,
    pub folder_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

fn map_note_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<NoteFileRow> {
    Ok(NoteFileRow {
        id: row.get(0)?,
        title: row.get(1)?,
        content: row.get(2)?,
        folder_id: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
    })
}

pub fn insert_note_file(conn: &Connection, id: &str) -> Result<NoteFileRow> {
    conn.execute(
        "INSERT INTO notes (id, title, content, created_at, updated_at)
         VALUES (?1, 'Untitled Note', '', datetime('now'), datetime('now'))",
        params![id],
    )?;
    let now = chrono::Utc::now().format("%Y-%m-%d %H:%M:%S").to_string();
    Ok(NoteFileRow {
        id: id.to_string(),
        title: "Untitled Note".to_string(),
        content: String::new(),
        folder_id: None,
        created_at: now.clone(),
        updated_at: now,
    })
}

pub fn get_note_file(conn: &Connection, id: &str) -> Result<Option<NoteFileRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, title, content, folder_id, created_at, updated_at FROM notes WHERE id = ?1",
    )?;
    Ok(stmt.query_row(params![id], map_note_row).optional()?)
}

pub fn list_note_files(
    conn: &Connection,
    search: Option<&str>,
    folder_id: Option<&str>,
) -> Result<Vec<NoteFileRow>> {
    let pattern = search.filter(|s| !s.is_empty()).map(|q| format!("%{q}%"));
    let rows: Vec<NoteFileRow> = match (pattern.as_deref(), folder_id) {
        (Some(p), Some(fid)) => {
            let mut s = conn.prepare(
                "SELECT id, title, content, folder_id, created_at, updated_at FROM notes \
                 WHERE folder_id = ?1 AND (title LIKE ?2 OR content LIKE ?2) \
                 ORDER BY updated_at DESC",
            )?;
            let r = s.query_map(params![fid, p], map_note_row)?.collect::<rusqlite::Result<_>>()?; r
        }
        (Some(p), None) => {
            let mut s = conn.prepare(
                "SELECT id, title, content, folder_id, created_at, updated_at FROM notes \
                 WHERE title LIKE ?1 OR content LIKE ?1 \
                 ORDER BY updated_at DESC",
            )?;
            let r = s.query_map(params![p], map_note_row)?.collect::<rusqlite::Result<_>>()?; r
        }
        (None, Some(fid)) => {
            let mut s = conn.prepare(
                "SELECT id, title, content, folder_id, created_at, updated_at FROM notes \
                 WHERE folder_id = ?1 \
                 ORDER BY updated_at DESC",
            )?;
            let r = s.query_map(params![fid], map_note_row)?.collect::<rusqlite::Result<_>>()?; r
        }
        (None, None) => {
            let mut s = conn.prepare(
                "SELECT id, title, content, folder_id, created_at, updated_at FROM notes \
                 ORDER BY updated_at DESC",
            )?;
            let r = s.query_map([], map_note_row)?.collect::<rusqlite::Result<_>>()?; r
        }
    };
    Ok(rows)
}

pub fn update_note_file_folder(conn: &Connection, id: &str, folder_id: Option<&str>) -> Result<()> {
    conn.execute(
        "UPDATE notes SET folder_id = ?1 WHERE id = ?2",
        params![folder_id, id],
    )?;
    Ok(())
}

pub fn update_note_file_title(conn: &Connection, id: &str, title: &str) -> Result<()> {
    conn.execute(
        "UPDATE notes SET title = ?1, updated_at = datetime('now') WHERE id = ?2",
        params![title, id],
    )?;
    Ok(())
}

pub fn update_note_file_content(conn: &Connection, id: &str, content: &str) -> Result<()> {
    conn.execute(
        "UPDATE notes SET content = ?1, updated_at = datetime('now') WHERE id = ?2",
        params![content, id],
    )?;
    Ok(())
}

pub fn delete_note_file(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM notes WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn delete_note_file_if_empty(conn: &Connection, id: &str) -> Result<bool> {
    let content: Option<String> = conn
        .query_row(
            "SELECT content FROM notes WHERE id = ?1",
            params![id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten();

    let is_empty = match &content {
        None => true,
        Some(html) => {
            let mut in_tag = false;
            let text: String = html.chars().filter(|&c| {
                if c == '<' { in_tag = true; false }
                else if c == '>' { in_tag = false; false }
                else { !in_tag }
            }).collect();
            text.trim().is_empty()
        }
    };

    if is_empty {
        delete_note_file(conn, id)?;
        Ok(true)
    } else {
        Ok(false)
    }
}

// --- Action items ---

pub fn get_action_items(conn: &Connection, meeting_id: &str) -> Result<Option<String>> {
    let mut stmt = conn.prepare("SELECT action_items FROM meetings WHERE id = ?1")?;
    let result = stmt
        .query_row(params![meeting_id], |row| row.get::<_, Option<String>>(0))
        .optional()?
        .flatten();
    Ok(result)
}

pub fn save_action_items(conn: &Connection, meeting_id: &str, json: &str) -> Result<()> {
    conn.execute(
        "UPDATE meetings SET action_items = ?1 WHERE id = ?2",
        params![json, meeting_id],
    )?;
    Ok(())
}

// --- Note-meeting links ---

pub fn link_note_meeting(conn: &Connection, note_id: &str, meeting_id: &str) -> Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO note_meetings (note_id, meeting_id) VALUES (?1, ?2)",
        params![note_id, meeting_id],
    )?;
    Ok(())
}

pub fn unlink_note_meeting(conn: &Connection, note_id: &str, meeting_id: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM note_meetings WHERE note_id = ?1 AND meeting_id = ?2",
        params![note_id, meeting_id],
    )?;
    Ok(())
}

pub struct LinkedMeetingRow {
    pub id: String,
    pub title: String,
    pub created_at: String,
}

pub fn get_note_linked_meetings(conn: &Connection, note_id: &str) -> Result<Vec<LinkedMeetingRow>> {
    let mut stmt = conn.prepare(
        "SELECT m.id, m.title, m.created_at \
         FROM meetings m JOIN note_meetings nm ON nm.meeting_id = m.id \
         WHERE nm.note_id = ?1 AND m.deleted_at IS NULL \
         ORDER BY nm.created_at DESC",
    )?;
    let r = stmt
        .query_map(params![note_id], |row| {
            Ok(LinkedMeetingRow { id: row.get(0)?, title: row.get(1)?, created_at: row.get(2)? })
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(r)
}

pub fn get_meeting_linked_notes(conn: &Connection, meeting_id: &str) -> Result<Vec<NoteFileRow>> {
    let mut stmt = conn.prepare(
        "SELECT n.id, n.title, n.content, n.folder_id, n.created_at, n.updated_at \
         FROM notes n JOIN note_meetings nm ON nm.note_id = n.id \
         WHERE nm.meeting_id = ?1 \
         ORDER BY nm.created_at DESC",
    )?;
    let r = stmt.query_map(params![meeting_id], map_note_row)?.collect::<rusqlite::Result<_>>()?;
    Ok(r)
}

// --- Rich notes (per-meeting) ---

pub fn get_notes_content(conn: &Connection, id: &str) -> Result<Option<String>> {
    let mut stmt = conn.prepare("SELECT notes_content FROM meetings WHERE id = ?1")?;
    let result = stmt
        .query_row(params![id], |row| row.get::<_, Option<String>>(0))
        .optional()?
        .flatten();
    Ok(result)
}

pub fn save_notes_content(conn: &Connection, id: &str, content: &str) -> Result<()> {
    conn.execute(
        "UPDATE meetings SET notes_content = ?1 WHERE id = ?2",
        params![content, id],
    )?;
    Ok(())
}

pub fn get_all_meeting_tags(
    conn: &Connection,
) -> Result<std::collections::HashMap<String, Vec<UserTagRow>>> {
    let mut stmt = conn.prepare(
        "SELECT mt.meeting_id, ut.id, ut.name, ut.color
         FROM meeting_tags mt
         JOIN user_tags ut ON ut.id = mt.tag_id
         ORDER BY ut.created_at ASC",
    )?;
    let mut map: std::collections::HashMap<String, Vec<UserTagRow>> =
        std::collections::HashMap::new();
    stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            UserTagRow { id: row.get(1)?, name: row.get(2)?, color: row.get(3)? },
        ))
    })?
    .filter_map(|r| r.ok())
    .for_each(|(mid, tag)| {
        map.entry(mid).or_default().push(tag);
    });
    Ok(map)
}
