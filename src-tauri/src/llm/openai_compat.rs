use std::sync::Arc;

use anyhow::{anyhow, Result};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use super::{ChatMessage, LlmEngine};

pub struct OllamaEngine {
    base_url: String,
    pub model: String,
}

impl OllamaEngine {
    pub fn new(base_url: impl Into<String>, model: impl Into<String>) -> Self {
        Self {
            base_url: base_url.into(),
            model: model.into(),
        }
    }

    fn native_base(&self) -> String {
        self.base_url.replace("/v1", "")
    }

    pub async fn check_health(&self) -> Result<()> {
        let client = reqwest::Client::new();
        let tags_url = self.native_base() + "/api/tags";

        let resp = client
            .get(&tags_url)
            .timeout(std::time::Duration::from_secs(5))
            .send()
            .await
            .map_err(|_| {
                anyhow!(
                    "Cannot reach Ollama at {}. Make sure it is running: ollama serve",
                    self.base_url
                )
            })?;

        let body: serde_json::Value = resp.json().await?;
        let models = body["models"]
            .as_array()
            .ok_or_else(|| anyhow!("Unexpected response from Ollama /api/tags"))?;

        let target = self.model.as_str();
        let found = models.iter().any(|m| {
            m["name"].as_str().map(|n| n == target).unwrap_or(false)
                || m["model"].as_str().map(|n| n == target).unwrap_or(false)
        });

        if !found {
            return Err(anyhow!(
                "Model '{}' is not pulled. Run: ollama pull {}",
                self.model,
                self.model
            ));
        }

        Ok(())
    }
}

// ---- Native Ollama /api/chat structs ----------------------------------------

#[derive(Serialize)]
struct NativeOptions {
    num_ctx: u32,
}

#[derive(Serialize)]
struct NativeChatRequest<'a> {
    model: &'a str,
    messages: &'a [ChatMessage],
    stream: bool,
    think: bool,
    options: NativeOptions,
}

#[derive(Deserialize)]
struct NativeMessage {
    content: String,
}

#[derive(Deserialize)]
struct NativeChatResponse {
    message: NativeMessage,
}

#[derive(Deserialize)]
struct NativeStreamChunk {
    message: Option<NativeMessage>,
    done: bool,
}

fn strip_thinking(text: &str) -> String {
    let mut s = text.to_string();
    while let (Some(start), Some(end)) = (s.find("<think>"), s.find("</think>")) {
        if start < end {
            s = format!("{}{}", &s[..start], s[end + 8..].trim_start());
        } else {
            break;
        }
    }
    s.trim().to_string()
}

// Estimate how large a context we need for a set of messages.
// Rough heuristic: 1 token ≈ 4 chars, plus 64-token overhead per message.
fn estimate_num_ctx(messages: &[ChatMessage]) -> u32 {
    let char_total: usize = messages.iter().map(|m| m.content.len()).sum();
    let token_estimate = (char_total / 4) + messages.len() * 64;
    // Round up to next power of two, minimum 4096, max 131072
    let needed = (token_estimate + 1024) as u32; // +1024 for response headroom
    [4096u32, 8192, 16384, 32768, 65536, 131072]
        .iter()
        .copied()
        .find(|&n| n >= needed)
        .unwrap_or(131072)
}

#[async_trait]
impl LlmEngine for OllamaEngine {
    async fn chat(&self, messages: Vec<ChatMessage>) -> Result<String> {
        let client = reqwest::Client::new();
        let url = format!("{}/api/chat", self.native_base());
        let num_ctx = estimate_num_ctx(&messages);

        let body = NativeChatRequest {
            model: &self.model,
            messages: &messages,
            stream: false,
            think: false,
            options: NativeOptions { num_ctx },
        };

        let resp = client
            .post(&url)
            .json(&body)
            .timeout(std::time::Duration::from_secs(600))
            .send()
            .await
            .map_err(|e| anyhow!("Ollama request failed: {e}"))?
            .error_for_status()
            .map_err(|e| anyhow!("Ollama returned error: {e}"))?;

        let parsed: NativeChatResponse = resp.json().await?;
        let raw = parsed.message.content;

        let result = strip_thinking(&raw);
        if result.is_empty() {
            return Err(anyhow!(
                "LLM returned empty content. The model may need more context (num_ctx={num_ctx}). Raw response: {:?}",
                &raw[..raw.len().min(200)]
            ));
        }
        Ok(result)
    }

    async fn chat_streaming(
        &self,
        messages: Vec<ChatMessage>,
        on_chunk: Arc<dyn Fn(String) + Send + Sync>,
    ) -> Result<String> {
        let client = reqwest::Client::new();
        let url = format!("{}/api/chat", self.native_base());
        let num_ctx = estimate_num_ctx(&messages);

        let body = NativeChatRequest {
            model: &self.model,
            messages: &messages,
            stream: true,
            think: false,
            options: NativeOptions { num_ctx },
        };

        let mut resp = client
            .post(&url)
            .json(&body)
            .timeout(std::time::Duration::from_secs(600))
            .send()
            .await
            .map_err(|e| anyhow!("Ollama request failed: {e}"))?
            .error_for_status()
            .map_err(|e| anyhow!("Ollama returned error: {e}"))?;

        let mut assembled = String::new();
        let mut buf = String::new();

        while let Some(bytes) = resp.chunk().await.map_err(|e| anyhow!("Stream read error: {e}"))? {
            buf.push_str(&String::from_utf8_lossy(&bytes));

            while let Some(nl) = buf.find('\n') {
                let line = buf[..nl].trim().to_string();
                buf = buf[nl + 1..].to_string();

                if line.is_empty() {
                    continue;
                }

                if let Ok(chunk) = serde_json::from_str::<NativeStreamChunk>(&line) {
                    if chunk.done {
                        break;
                    }
                    if let Some(msg) = chunk.message {
                        let content = msg.content;
                        if !content.is_empty() {
                            assembled.push_str(&content);
                            on_chunk(content);
                        }
                    }
                }
            }
        }

        Ok(assembled.trim().to_string())
    }
}
