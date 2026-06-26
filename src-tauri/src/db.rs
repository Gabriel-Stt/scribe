use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};

pub fn init(conn: &Connection) -> Result<()> {
    // Migrate pre-Phase-2 DBs that lack the elapsed_seconds column
    let _ = conn.execute_batch(
        "ALTER TABLE manual_notes ADD COLUMN elapsed_seconds REAL NOT NULL DEFAULT 0;",
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
             full_text   TEXT NOT NULL DEFAULT ''
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
    segments: &[(f64, f64, &str)],  // (start, end, text)
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
    Ok(id)
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
    pub created_at: String,
    pub duration_seconds: Option<f64>,
    pub audio_path: Option<String>,
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

pub fn list_meetings(conn: &Connection, search: Option<&str>) -> Result<Vec<MeetingRow>> {
    if let Some(q) = search.filter(|s| !s.is_empty()) {
        let pattern = format!("%{q}%");
        let mut stmt = conn.prepare(
            "SELECT id, title, subject_tag, created_at, duration_seconds, audio_path
             FROM meetings WHERE title LIKE ?1 OR full_text LIKE ?1
             ORDER BY created_at DESC",
        )?;
        let rows = stmt
            .query_map(params![pattern], row_to_meeting)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    } else {
        let mut stmt = conn.prepare(
            "SELECT id, title, subject_tag, created_at, duration_seconds, audio_path
             FROM meetings ORDER BY created_at DESC",
        )?;
        let rows = stmt
            .query_map([], row_to_meeting)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }
}

fn row_to_meeting(row: &rusqlite::Row<'_>) -> rusqlite::Result<MeetingRow> {
    Ok(MeetingRow {
        id: row.get(0)?,
        title: row.get(1)?,
        subject_tag: row.get(2)?,
        created_at: row.get(3)?,
        duration_seconds: row.get(4)?,
        audio_path: row.get(5)?,
    })
}

pub fn get_meeting(conn: &Connection, id: &str) -> Result<Option<MeetingRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, title, subject_tag, created_at, duration_seconds, audio_path
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
