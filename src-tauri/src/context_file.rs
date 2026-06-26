use std::path::Path;

use crate::llm::ChatMessage;

const LOCKED_BASE_PROMPT: &str = "\
You are a transcription summarization assistant integrated into a local-only \
lecture/meeting capture app. You will be given a full transcript of an audio \
recording, optionally followed by custom instructions from the user describing \
how they want this kind of content summarized.

Default behavior (use this unless the custom instructions below explicitly \
override it):
- Output the summary as structured bullet points grouped under clear headers.
- Preserve specific facts, numbers, formulas, names, and dates exactly as \
stated — never approximate or invent details not present in the transcript.
- If part of the transcript is unclear or garbled, note that gap explicitly \
rather than guessing.
- Keep the summary proportional to content density, not transcript length.

Custom instructions from the user may override formatting and style choices \
(e.g. \"summarize as a single paragraph\" or \"always include a vocabulary \
list\"), but they never override the factual-accuracy and gap-disclosure rules \
above — those always apply.";

const CHAT_SYSTEM_PROMPT: &str = "\
You are answering questions about a specific recorded transcript inside a \
local-only app. The transcript is your primary source.

When answering:
1. First look for the answer directly in the transcript.
2. If the transcript contains closely related content, you may reason from \
it — drawing natural inferences a careful listener would make from what was said.
3. Only say information is unavailable if the question is entirely unrelated \
to anything discussed in the transcript.

Never invent specific facts (numbers, names, dates) that are not grounded in \
the transcript. Reasonable interpretation of what was said is fine.";

pub fn load_context(data_dir: &Path) -> String {
    let path = data_dir.join("context.md");
    std::fs::read_to_string(&path).unwrap_or_default()
}

pub fn save_context(data_dir: &Path, content: &str) -> std::io::Result<()> {
    std::fs::write(data_dir.join("context.md"), content)
}

pub fn append_to_context(data_dir: &Path, instruction: &str) -> std::io::Result<()> {
    let existing = load_context(data_dir);
    let separator = if existing.is_empty() || existing.ends_with('\n') {
        ""
    } else {
        "\n"
    };
    let new_content = format!("{existing}{separator}\n{instruction}\n");
    save_context(data_dir, &new_content)
}

pub fn build_summarization_messages(transcript: &str, context_md: &str) -> Vec<ChatMessage> {
    let system = format!(
        "{LOCKED_BASE_PROMPT}\n\n\
         --- USER CUSTOM INSTRUCTIONS ---\n\
         {context_md}\n\
         --- END USER CUSTOM INSTRUCTIONS ---"
    );
    vec![
        ChatMessage::system(system),
        ChatMessage::user(format!("Transcript follows:\n\n{transcript}")),
    ]
}

pub fn build_resummary_messages(
    transcript: &str,
    context_md: &str,
    instruction: &str,
) -> Vec<ChatMessage> {
    let mut messages = build_summarization_messages(transcript, context_md);
    messages.push(ChatMessage::user(format!(
        "Please re-summarize the transcript with the following instruction: {instruction}"
    )));
    messages
}

pub fn build_chat_system_message(transcript: &str) -> ChatMessage {
    ChatMessage::system(format!("{CHAT_SYSTEM_PROMPT}\n\nTranscript:\n{transcript}"))
}

pub fn build_title_messages(transcript_excerpt: &str) -> Vec<ChatMessage> {
    vec![
        ChatMessage::system(
            "Generate a short, descriptive title (4–7 words) for this recording based on the \
             transcript excerpt. Reply with ONLY the title — no quotes, no period at the end, \
             no explanation."
                .to_string(),
        ),
        ChatMessage::user(format!("Transcript excerpt:\n{transcript_excerpt}")),
    ]
}

pub fn build_markdown_export(
    title: &str,
    subject: Option<&str>,
    created_at: &str,
    duration_seconds: Option<f64>,
    summary: Option<&str>,
    segments: &[(f64, f64, &str)],
    notes: &[(f64, &str)],
) -> String {
    let mut out = String::new();
    out.push_str(&format!("# {title}\n\n"));

    out.push_str("| | |\n|---|---|\n");
    out.push_str(&format!("| **Date** | {created_at} |\n"));
    if let Some(tag) = subject {
        out.push_str(&format!("| **Subject** | {tag} |\n"));
    }
    if let Some(dur) = duration_seconds {
        let mins = (dur / 60.0) as u32;
        let secs = (dur % 60.0) as u32;
        out.push_str(&format!("| **Duration** | {mins}:{secs:02} |\n"));
    }
    out.push('\n');

    if let Some(s) = summary {
        out.push_str("## Summary\n\n");
        out.push_str(s);
        out.push_str("\n\n");
    }

    if !segments.is_empty() {
        out.push_str("## Transcript\n\n");
        for (start, _end, text) in segments {
            let m = (*start / 60.0) as u32;
            let s = (*start % 60.0) as u32;
            out.push_str(&format!("**{m}:{s:02}** — {text}\n\n"));
        }
    }

    if !notes.is_empty() {
        out.push_str("## Notes\n\n");
        for (elapsed, text) in notes {
            let m = (*elapsed / 60.0) as u32;
            let s = (*elapsed % 60.0) as u32;
            out.push_str(&format!("**{m}:{s:02}** — {text}\n\n"));
        }
    }

    out
}
