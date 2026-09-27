# Scribe

A local-first desktop app for capturing lectures and meetings — it records audio, transcribes it on-device, and turns the transcript into organized, searchable notes with an AI assistant layered on top.

Built to solve a simple problem: taking good notes in a dense lecture usually means missing half of what's said. Scribe records and transcribes in the background so you can stay focused on the room, then lets you summarize, search, and chat with the material afterward.

## Features

- **Recording** — start/pause/resume, device selection, live input level meter
- **On-device transcription** — audio is transcribed locally through a bundled Parakeet ASR sidecar; nothing leaves your machine
- **Automatic summaries** — meetings and lectures are summarized on import, and can be regenerated on demand
- **Context-aware summarization** — a per-subject context file can steer tone and structure (e.g. pull formulas to the top for chemistry, keep a running timeline for history, cap business notes at five takeaways)
- **Notes + split view** — view a note and a chat side by side, or compare two notes at once
- **Chat with your notes** — ask questions against your transcripts through any OpenAI-compatible LLM endpoint, with streaming responses
- **Search, folders, trash** — global search (⌘/Ctrl+K), folder organization, and recoverable deletion

## Tech stack

| Layer | Tools |
|---|---|
| UI | React 19, TypeScript, Tailwind CSS, Vite |
| Desktop shell | Tauri 2 (Rust) |
| Audio | `cpal` for capture, `hound` for encoding |
| Storage | SQLite (`rusqlite`, bundled) |
| Transcription | Local Python sidecar running NVIDIA Parakeet |
| Summaries / chat | Any OpenAI-compatible LLM endpoint |

## Running locally

Requires Node.js and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) (Rust toolchain + platform build tools) for your OS.

```bash
npm install
npm run tauri dev
```

## Status

Personal, actively-developed project — currently built and used for my own coursework, not yet packaged for distribution.
