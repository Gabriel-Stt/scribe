use std::path::Path;

use anyhow::Result;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TranscriptSegment {
    pub text: String,
    pub start: f64,
    pub end: f64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Transcript {
    pub segments: Vec<TranscriptSegment>,
    pub full_text: String,
}

#[async_trait]
pub trait AsrEngine: Send + Sync {
    async fn transcribe(&self, audio_path: &Path) -> Result<Transcript>;
    async fn is_ready(&self) -> bool;
}

pub mod parakeet;
