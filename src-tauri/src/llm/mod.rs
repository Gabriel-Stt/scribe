use anyhow::Result;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

impl ChatMessage {
    pub fn system(content: impl Into<String>) -> Self {
        Self { role: "system".into(), content: content.into() }
    }
    pub fn user(content: impl Into<String>) -> Self {
        Self { role: "user".into(), content: content.into() }
    }
    pub fn assistant(content: impl Into<String>) -> Self {
        Self { role: "assistant".into(), content: content.into() }
    }
}

#[async_trait]
pub trait LlmEngine: Send + Sync {
    async fn chat(&self, messages: Vec<ChatMessage>) -> Result<String>;

    /// Like `chat`, but calls `on_chunk` with each text fragment as it arrives.
    /// Default: falls back to `chat` and emits the full response as one chunk.
    async fn chat_streaming(
        &self,
        messages: Vec<ChatMessage>,
        on_chunk: std::sync::Arc<dyn Fn(String) + Send + Sync>,
    ) -> Result<String> {
        let result = self.chat(messages).await?;
        on_chunk(result.clone());
        Ok(result)
    }
}

pub mod openai_compat;
