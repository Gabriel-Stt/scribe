use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};

pub fn init(conn: &Connection) -> Result<()> {
    // Safe migrations for pre-existing columns
    let _ = conn.execute_batch(
        "ALTER TABLE manual_notes ADD COLUMN elapsed_seconds REAL NOT NULL DEFAULT 0;",
    );
    let _ = conn.execute_batch("ALTER TABLE meetings ADD COLUMN folder_id TEXT;");
    let _ = conn.execute_batch("ALTER TABLE meetings ADD COLUMN active_summary_version INTEGER;");

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
             active_summary_version INTEGER
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
         );",
    )?;
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

pub fn list_meetings(
    conn: &Connection,
    search: Option<&str>,
    folder_id: Option<&str>,
) -> Result<Vec<MeetingRow>> {
    let pattern = search
        .filter(|s| !s.is_empty())
        .map(|q| format!("%{q}%"));

    let rows: Vec<MeetingRow> = match (pattern.as_deref(), folder_id) {
        (Some(p), Some(fid)) => {
            let mut stmt = conn.prepare(
                "SELECT id, title, subject_tag, created_at, duration_seconds, audio_path, folder_id, active_summary_version
                 FROM meetings WHERE folder_id = ?1 AND (title LIKE ?2 OR full_text LIKE ?2)
                 ORDER BY created_at DESC",
            )?;
            let r = stmt.query_map(params![fid, p], row_to_meeting)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            r
        }
        (Some(p), None) => {
            let mut stmt = conn.prepare(
                "SELECT id, title, subject_tag, created_at, duration_seconds, audio_path, folder_id, active_summary_version
                 FROM meetings WHERE title LIKE ?1 OR full_text LIKE ?1
                 ORDER BY created_at DESC",
            )?;
            let r = stmt.query_map(params![p], row_to_meeting)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            r
        }
        (None, Some(fid)) => {
            let mut stmt = conn.prepare(
                "SELECT id, title, subject_tag, created_at, duration_seconds, audio_path, folder_id, active_summary_version
                 FROM meetings WHERE folder_id = ?1
                 ORDER BY created_at DESC",
            )?;
            let r = stmt.query_map(params![fid], row_to_meeting)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            r
        }
        (None, None) => {
            let mut stmt = conn.prepare(
                "SELECT id, title, subject_tag, created_at, duration_seconds, audio_path, folder_id, active_summary_version
                 FROM meetings ORDER BY created_at DESC",
            )?;
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
    })
}

pub fn get_meeting(conn: &Connection, id: &str) -> Result<Option<MeetingRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, title, subject_tag, created_at, duration_seconds, audio_path, folder_id, active_summary_version
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
    conn.execute("DELETE FROM chat_messages WHERE meeting_id = ?1", params![id])?;
    conn.execute("DELETE FROM summaries WHERE meeting_id = ?1", params![id])?;
    conn.execute("DELETE FROM manual_notes WHERE meeting_id = ?1", params![id])?;
    conn.execute("DELETE FROM transcript_segments WHERE meeting_id = ?1", params![id])?;
    conn.execute("DELETE FROM meetings WHERE id = ?1", params![id])?;
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
    // Get tag name first, then clear it from meetings
    let name: Option<String> = conn.query_row(
        "SELECT name FROM user_tags WHERE id = ?1",
        params![id],
        |row| row.get(0),
    ).optional()?;
    if let Some(n) = name {
        conn.execute(
            "UPDATE meetings SET subject_tag = NULL WHERE subject_tag = ?1",
            params![n],
        )?;
    }
    conn.execute("DELETE FROM user_tags WHERE id = ?1", params![id])?;
    Ok(())
}
