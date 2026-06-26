import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// ---- Types matching Rust structs ----

interface TranscriptSegment {
  text: string;
  start: number;
  end: number;
}

interface Transcript {
  segments: TranscriptSegment[];
  full_text: string;
}

interface StatusResponse {
  asr_ready: boolean;
  llm_ready: boolean;
  llm_error: string | null;
  recording_status: "idle" | "recording" | "paused";
}

interface MeetingResult {
  meeting_id: string;
  summary: string;
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

// ---- App state type ----

type Phase =
  | "idle"
  | "recording"
  | "paused"
  | "transcribing"
  | "saving"
  | "done";

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export default function App() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [audioPath, setAudioPath] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [meeting, setMeeting] = useState<MeetingResult | null>(null);
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [resummaryInput, setResummaryInput] = useState("");
  const [currentSummary, setCurrentSummary] = useState<string | null>(null);
  const [contextText, setContextText] = useState("");
  const [showContext, setShowContext] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [streamingContent, setStreamingContent] = useState<string | null>(null);

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // ---- Status polling ----

  const pollStatus = useCallback(async () => {
    try {
      const s = await invoke<StatusResponse>("get_status");
      setStatus(s);
    } catch {
      // silently ignore during startup
    }
  }, []);

  useEffect(() => {
    pollStatus();
    const id = setInterval(pollStatus, 2000);
    return () => clearInterval(id);
  }, [pollStatus]);

  // ---- Timer ----

  useEffect(() => {
    if (phase === "recording") {
      timerRef.current = setInterval(
        () => setElapsedSeconds((s) => s + 1),
        1000
      );
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [phase]);

  // ---- Scroll chat to bottom ----

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatHistory]);

  // ---- Load context on show ----

  useEffect(() => {
    if (showContext) {
      invoke<string>("get_context").then(setContextText).catch(() => {});
    }
  }, [showContext]);

  // ---- Handlers ----

  async function handleStart() {
    setError(null);
    try {
      await invoke("start_recording");
      setPhase("recording");
      setElapsedSeconds(0);
      setAudioPath(null);
      setTranscript(null);
      setMeeting(null);
      setChatHistory([]);
      setCurrentSummary(null);
    } catch (e) {
      setError(String(e));
    }
  }

  async function handlePause() {
    try {
      await invoke("pause_recording");
      setPhase("paused");
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleResume() {
    try {
      await invoke("resume_recording");
      setPhase("recording");
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleStop() {
    setError(null);
    try {
      const path = await invoke<string>("stop_recording");
      setAudioPath(path);
      setPhase("transcribing");

      // Auto-transcribe then auto-create meeting
      const tx = await invoke<Transcript>("transcribe_audio", {
        audioPath: path,
      });
      setTranscript(tx);
      setPhase("saving");

      const title = `Recording ${new Date().toLocaleString()}`;
      const result = await invoke<MeetingResult>("create_meeting", {
        args: { title, audio_path: path, transcript: tx },
      });
      setMeeting(result);
      setCurrentSummary(result.summary);
      setPhase("done");
    } catch (e) {
      setError(String(e));
      setPhase("idle");
    }
  }

  async function handleResummary() {
    if (!meeting || !resummaryInput.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const newSummary = await invoke<string>("resummmarize", {
        args: {
          meeting_id: meeting.meeting_id,
          instruction: resummaryInput.trim(),
        },
      });
      setCurrentSummary(newSummary);
      setResummaryInput("");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleChat() {
    if (!meeting || !chatInput.trim()) return;
    const msg = chatInput.trim();
    setChatInput("");
    setChatHistory((h) => [...h, { role: "user", content: msg }]);
    setStreamingContent("");
    setBusy(true);
    setError(null);

    const unlisten = await listen<string>("chat-chunk", (event) => {
      setStreamingContent((prev) => (prev ?? "") + event.payload);
    });

    try {
      const resp = await invoke<{ response: string }>("send_chat_message", {
        args: { meeting_id: meeting.meeting_id, message: msg },
      });
      setChatHistory((h) => [
        ...h,
        { role: "assistant", content: resp.response },
      ]);
    } catch (e) {
      setError(String(e));
    } finally {
      unlisten();
      setStreamingContent(null);
      setBusy(false);
    }
  }

  async function handleSaveContext() {
    try {
      await invoke("save_context", { content: contextText });
      setShowContext(false);
    } catch (e) {
      setError(String(e));
    }
  }

  // ---- Render ----

  const asrOk = status?.asr_ready ?? false;
  const llmOk = status?.llm_ready ?? false;
  const isRecording = phase === "recording";
  const isPaused = phase === "paused";
  const isDone = phase === "done";
  const isProcessing = phase === "transcribing" || phase === "saving";

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 flex flex-col">
      {/* Header */}
      <header className="border-b border-gray-800 px-6 py-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-tight text-white">
          Scribe
          <span className="ml-2 text-xs font-normal text-gray-500 uppercase tracking-widest">
            Phase 1
          </span>
        </h1>
        <div className="flex items-center gap-4 text-xs">
          <StatusDot ok={asrOk} label="ASR" />
          <StatusDot ok={llmOk} label="LLM" title={status?.llm_error ?? undefined} />
          <button
            onClick={() => setShowContext((v) => !v)}
            className="text-gray-400 hover:text-white underline underline-offset-2"
          >
            Context file
          </button>
        </div>
      </header>

      <main className="flex-1 p-6 max-w-4xl mx-auto w-full space-y-6">
        {/* Error banner */}
        {error && (
          <div className="bg-red-900/50 border border-red-700 rounded-lg p-4 text-sm text-red-300 flex justify-between">
            <span>{error}</span>
            <button
              onClick={() => setError(null)}
              className="text-red-400 hover:text-white ml-4 shrink-0"
            >
              ✕
            </button>
          </div>
        )}

        {/* Context file editor */}
        {showContext && (
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-5 space-y-3">
            <h2 className="font-medium text-gray-200">context.md — Custom Instructions</h2>
            <p className="text-xs text-gray-500">
              These instructions layer on top of the built-in prompt. They can
              change format and tone but cannot disable factual-accuracy rules.
            </p>
            <textarea
              value={contextText}
              onChange={(e) => setContextText(e.target.value)}
              className="w-full h-40 bg-gray-800 border border-gray-700 rounded-lg p-3 text-sm font-mono text-gray-200 focus:outline-none focus:ring-1 focus:ring-indigo-500 resize-y"
              placeholder="e.g. For Chemistry: always list formulas in a separate section."
            />
            <div className="flex gap-3">
              <button onClick={handleSaveContext} className="btn-primary">
                Save
              </button>
              <button
                onClick={() => setShowContext(false)}
                className="btn-ghost"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Recording controls */}
        <section className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <h2 className="text-sm font-medium text-gray-400 uppercase tracking-widest mb-4">
            Recording
          </h2>
          <div className="flex items-center gap-4 flex-wrap">
            {!isRecording && !isPaused && !isProcessing && !isDone && (
              <button
                onClick={handleStart}
                disabled={!asrOk || !llmOk}
                className="btn-primary disabled:opacity-40 disabled:cursor-not-allowed"
              >
                ● Start Recording
              </button>
            )}
            {isRecording && (
              <>
                <button onClick={handlePause} className="btn-ghost">
                  ⏸ Pause
                </button>
                <button onClick={handleStop} className="btn-danger">
                  ■ Stop
                </button>
              </>
            )}
            {isPaused && (
              <>
                <button onClick={handleResume} className="btn-primary">
                  ▶ Resume
                </button>
                <button onClick={handleStop} className="btn-danger">
                  ■ Stop & Transcribe
                </button>
              </>
            )}
            {isProcessing && (
              <div className="flex items-center gap-3 text-gray-400 text-sm">
                <Spinner />
                {phase === "transcribing"
                  ? "Transcribing audio…"
                  : "Generating summary…"}
              </div>
            )}
            {(isRecording || isPaused) && (
              <span
                className={`font-mono text-lg tabular-nums ${isRecording ? "text-red-400" : "text-yellow-400"}`}
              >
                {isRecording ? "● " : "⏸ "}
                {formatTime(elapsedSeconds)}
              </span>
            )}
          </div>
          {!asrOk && (
            <p className="mt-3 text-xs text-amber-500">
              ASR model is loading — recording will start but transcription
              won't be available until it's ready.
            </p>
          )}
          {status?.llm_error && (
            <p className="mt-3 text-xs text-red-400">{status.llm_error}</p>
          )}
        </section>

        {/* Transcript */}
        {transcript && (
          <section className="bg-gray-900 border border-gray-800 rounded-xl p-5">
            <h2 className="text-sm font-medium text-gray-400 uppercase tracking-widest mb-3">
              Transcript
              <span className="ml-2 normal-case text-gray-600 font-normal">
                ({transcript.segments.length} segments)
              </span>
            </h2>
            <div className="max-h-60 overflow-y-auto space-y-1 pr-1">
              {transcript.segments.map((seg, i) => (
                <div key={i} className="flex gap-3 text-sm">
                  <span className="text-gray-600 font-mono shrink-0 w-14 text-right">
                    {formatTime(Math.floor(seg.start))}
                  </span>
                  <span className="text-gray-300">{seg.text}</span>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Summary */}
        {currentSummary && (
          <section className="bg-gray-900 border border-gray-800 rounded-xl p-5">
            <h2 className="text-sm font-medium text-gray-400 uppercase tracking-widest mb-3">
              Summary
            </h2>
            <div className="md-body text-sm text-gray-300">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {currentSummary}
              </ReactMarkdown>
            </div>

            {/* Resummary */}
            <div className="mt-4 pt-4 border-t border-gray-800 flex gap-3">
              <input
                type="text"
                value={resummaryInput}
                onChange={(e) => setResummaryInput(e.target.value)}
                placeholder="Re-summarize with different instructions…"
                onKeyDown={(e) => e.key === "Enter" && handleResummary()}
                className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
              <button
                onClick={handleResummary}
                disabled={busy || !resummaryInput.trim()}
                className="btn-secondary disabled:opacity-40"
              >
                {busy ? <Spinner /> : "Regenerate"}
              </button>
              <button
                onClick={async () => {
                  if (!resummaryInput.trim()) return;
                  await invoke("save_preference", {
                    instruction: resummaryInput.trim(),
                  });
                  alert("Preference saved to context.md");
                }}
                disabled={!resummaryInput.trim()}
                className="btn-ghost disabled:opacity-40 text-xs"
                title="Save this instruction to context.md as a default"
              >
                Save preference
              </button>
            </div>
          </section>
        )}

        {/* Chat */}
        {meeting && (
          <section className="bg-gray-900 border border-gray-800 rounded-xl p-5 flex flex-col gap-4">
            <h2 className="text-sm font-medium text-gray-400 uppercase tracking-widest">
              Ask about this recording
            </h2>
            <div className="min-h-32 max-h-80 overflow-y-auto space-y-3 pr-1">
              {chatHistory.length === 0 && (
                <p className="text-gray-600 text-sm italic">
                  Ask a question about the transcript…
                </p>
              )}
              {chatHistory.map((msg, i) => (
                <div
                  key={i}
                  className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
                >
                  <div
                    className={`max-w-[85%] rounded-xl px-4 py-2 text-sm ${
                      msg.role === "user"
                        ? "bg-indigo-600 text-white"
                        : "bg-gray-800 text-gray-200"
                    }`}
                  >
                    {msg.role === "assistant" ? (
                      <div className="md-body">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                          {msg.content}
                        </ReactMarkdown>
                      </div>
                    ) : (
                      <span className="whitespace-pre-wrap">{msg.content}</span>
                    )}
                  </div>
                </div>
              ))}
              {streamingContent !== null && (
                <div className="flex justify-start">
                  <div className="max-w-[85%] bg-gray-800 text-gray-200 rounded-xl px-4 py-2 text-sm">
                    <div className="md-body">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {streamingContent || "​"}
                      </ReactMarkdown>
                    </div>
                    <span className="inline-block w-1.5 h-3.5 bg-gray-400 animate-pulse align-middle ml-0.5" />
                  </div>
                </div>
              )}
              <div ref={chatEndRef} />
            </div>
            <div className="flex gap-3 pt-2 border-t border-gray-800">
              <input
                type="text"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                placeholder="Ask a question…"
                onKeyDown={(e) =>
                  e.key === "Enter" && !e.shiftKey && handleChat()
                }
                className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
              <button
                onClick={handleChat}
                disabled={busy || !chatInput.trim()}
                className="btn-primary disabled:opacity-40"
              >
                Send
              </button>
            </div>
          </section>
        )}

        {/* New recording button after done */}
        {isDone && (
          <div className="text-center">
            <button
              onClick={() => {
                setPhase("idle");
                setAudioPath(null);
                setTranscript(null);
                setMeeting(null);
                setChatHistory([]);
                setCurrentSummary(null);
                setElapsedSeconds(0);
              }}
              className="btn-ghost"
            >
              + New Recording
            </button>
          </div>
        )}
      </main>
    </div>
  );
}

function StatusDot({
  ok,
  label,
  title,
}: {
  ok: boolean;
  label: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`flex items-center gap-1.5 ${title ? "cursor-help" : ""}`}
    >
      <span
        className={`w-2 h-2 rounded-full ${ok ? "bg-emerald-400" : "bg-amber-400 animate-pulse"}`}
      />
      <span className={ok ? "text-gray-400" : "text-amber-400"}>{label}</span>
    </span>
  );
}

function Spinner() {
  return (
    <svg
      className="animate-spin h-4 w-4 text-gray-400"
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8v8H4z"
      />
    </svg>
  );
}
