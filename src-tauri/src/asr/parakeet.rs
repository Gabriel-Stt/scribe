use std::path::Path;

use anyhow::{anyhow, Result};
use async_trait::async_trait;
use serde::Deserialize;

use super::{AsrEngine, Transcript, TranscriptSegment};

pub struct ParakeetSidecarEngine {
    base_url: String,
}

impl ParakeetSidecarEngine {
    pub fn new(port: u16) -> Self {
        Self {
            base_url: format!("http://127.0.0.1:{port}"),
        }
    }
}

#[derive(Deserialize)]
struct SidecarSegment {
    text: String,
    start: f64,
    end: f64,
}

#[derive(Deserialize)]
struct SidecarResponse {
    segments: Vec<SidecarSegment>,
    full_text: String,
}

#[async_trait]
impl AsrEngine for ParakeetSidecarEngine {
    async fn transcribe(&self, audio_path: &Path) -> Result<Transcript> {
        let path_str = audio_path
            .to_str()
            .ok_or_else(|| anyhow!("Invalid audio path (non-UTF8)"))?;

        let client = reqwest::Client::new();
        let resp = client
            .post(format!("{}/transcribe", self.base_url))
            .json(&serde_json::json!({ "audio_path": path_str }))
            .timeout(std::time::Duration::from_secs(3600))
            .send()
            .await
            .map_err(|e| anyhow!("ASR sidecar unreachable: {e}"))?
            .error_for_status()
            .map_err(|e| anyhow!("ASR sidecar error: {e}"))?;

        let body: SidecarResponse = resp.json().await?;

        Ok(Transcript {
            full_text: body.full_text,
            segments: body
                .segments
                .into_iter()
                .map(|s| TranscriptSegment {
                    text: s.text,
                    start: s.start,
                    end: s.end,
                })
                .collect(),
        })
    }

    async fn is_ready(&self) -> bool {
        let client = reqwest::Client::new();
        match client
            .get(format!("{}/health", self.base_url))
            .timeout(std::time::Duration::from_secs(2))
            .send()
            .await
        {
            Ok(resp) => {
                if let Ok(body) = resp.json::<serde_json::Value>().await {
                    body["status"] == "ready"
                } else {
                    false
                }
            }
            Err(_) => false,
        }
    }
}
