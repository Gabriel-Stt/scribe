use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};

pub fn init(conn: &Connection) -> Result<()> {
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
             id          TEXT PRIMARY KEY,
             meeting_id  TEXT NOT NULL,
             timestamp   TEXT NOT NULL,
             text        TEXT NOT NULL,
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
