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

    pub async fn check_health(&self) -> Result<()> {
        let client = reqwest::Client::new();
        let tags_url = self.base_url.replace("/v1", "") + "/api/tags";

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

#[derive(Serialize)]
struct OpenAIRequest<'a> {
    model: &'a str,
    messages: &'a [ChatMessage],
    stream: bool,
    think: bool,
}

#[derive(Deserialize)]
struct OpenAIChoice {
    message: ChatMessage,
}

#[derive(Deserialize)]
struct OpenAIResponse {
    choices: Vec<OpenAIChoice>,
}

#[derive(Deserialize)]
struct StreamDelta {
    content: Option<String>,
}

#[derive(Deserialize)]
struct StreamChoice {
    delta: StreamDelta,
}

#[derive(Deserialize)]
struct StreamChunk {
    choices: Vec<StreamChoice>,
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

#[async_trait]
impl LlmEngine for OllamaEngine {
    async fn chat(&self, messages: Vec<ChatMessage>) -> Result<String> {
        let client = reqwest::Client::new();
        let url = format!("{}/chat/completions", self.base_url);

        let body = OpenAIRequest {
            model: &self.model,
            messages: &messages,
            stream: false,
            think: false,
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

        let parsed: OpenAIResponse = resp.json().await?;
        let raw = parsed
            .choices
            .into_iter()
            .next()
            .map(|c| c.message.content)
            .ok_or_else(|| anyhow!("Empty response from LLM"))?;

        Ok(strip_thinking(&raw))
    }

    async fn chat_streaming(
        &self,
        messages: Vec<ChatMessage>,
        on_chunk: Arc<dyn Fn(String) + Send + Sync>,
    ) -> Result<String> {
        let client = reqwest::Client::new();
        let url = format!("{}/chat/completions", self.base_url);

        let body = OpenAIRequest {
            model: &self.model,
            messages: &messages,
            stream: true,
            think: false,
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

                let Some(data) = line.strip_prefix("data: ") else {
                    continue;
                };
                if data.trim() == "[DONE]" {
                    continue;
                }
                if let Ok(chunk) = serde_json::from_str::<StreamChunk>(data) {
                    if let Some(content) = chunk
                        .choices
                        .first()
                        .and_then(|c| c.delta.content.as_deref())
                    {
                        if !content.is_empty() {
                            assembled.push_str(content);
                            on_chunk(content.to_string());
                        }
                    }
                }
            }
        }

        Ok(assembled.trim().to_string())
    }
}
