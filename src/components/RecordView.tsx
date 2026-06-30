import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { Transcript, TranscriptSegment, StatusResponse, MeetingResult, AppView, Folder } from "../lib/types";
import { formatTime, Spinner, StatusDot } from "./shared";

interface RecordViewProps {
  onMeetingReady: (id: string) => void;
  onNavigate: (view: AppView) => void;
}

type Phase = "idle" | "recording" | "paused" | "transcribing" | "saving" | "done";

export default function RecordView({ onMeetingReady }: RecordViewProps) {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [_audioPath, setAudioPath] = useState<string | null>(null);
  const [liveSegments, setLiveSegments] = useState<TranscriptSegment[]>([]);
  const [noteInput, setNoteInput] = useState("");
  const [notes, setNotes] = useState<{ elapsed: number; text: string }[]>([]);
  const [meetingId, setMeetingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [audioLevel, setAudioLevel] = useState(0);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [showFolderPicker, setShowFolderPicker] = useState(false);
  const folderPickerRef = useRef<HTMLDivElement>(null);

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const elapsedRef = useRef(0);
  const transcriptEndRef = useRef<HTMLDivElement>(null);
  const levelPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    invoke<Folder[]>("list_folders").then(setFolders).catch(() => {});
  }, []);

  useEffect(() => {
    if (!showFolderPicker) return;
    const h = (e: MouseEvent) => {
      if (folderPickerRef.current && !folderPickerRef.current.contains(e.target as Node))
        setShowFolderPicker(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [showFolderPicker]);

  // Status polling
  const pollStatus = useCallback(async () => {
    try {
      const s = await invoke<StatusResponse>("get_status");
      setStatus(s);
    } catch {
      // ignore during startup
    }
  }, []);

  useEffect(() => {
    pollStatus();
    const id = setInterval(pollStatus, 2000);
    return () => clearInterval(id);
  }, [pollStatus]);

  // Timer
  useEffect(() => {
    if (phase === "recording") {
      timerRef.current = setInterval(() => {
        setElapsedSeconds((s) => {
          elapsedRef.current = s + 1;
          return s + 1;
        });
      }, 1000);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [phase]);

  // Audio level meter polling
  useEffect(() => {
    if (phase === "recording") {
      levelPollRef.current = setInterval(async () => {
        try {
          const level = await invoke<number>("get_audio_level");
          setAudioLevel(level);
        } catch { /* ignore */ }
      }, 100);
    } else {
      if (levelPollRef.current) clearInterval(levelPollRef.current);
      if (phase === "idle") setAudioLevel(0);
    }
    return () => {
      if (levelPollRef.current) clearInterval(levelPollRef.current);
    };
  }, [phase]);

  // Live transcript events
  useEffect(() => {
    const unlistenLive = listen<TranscriptSegment>("transcript-live-segment", (e) => {
      setLiveSegments((prev) => {
        const exists = prev.some((s) => Math.abs(s.start - e.payload.start) < 0.5);
        return exists ? prev : [...prev, e.payload];
      });
    });

    const unlistenFinal = listen<TranscriptSegment>("transcript-segment", (e) => {
      setLiveSegments((prev) => {
        const exists = prev.some((s) => Math.abs(s.start - e.payload.start) < 0.5);
        return exists ? prev : [...prev, e.payload];
      });
    });

    return () => {
      unlistenLive.then((u) => u());
      unlistenFinal.then((u) => u());
    };
  }, []);

  // Scroll transcript to bottom
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [liveSegments]);

  async function handleStart() {
    setError(null);
    setLiveSegments([]);
    setNotes([]);
    setNoteInput("");
    setAudioPath(null);
    setMeetingId(null);
    setElapsedSeconds(0);
    elapsedRef.current = 0;
    try {
      await invoke("start_recording");
      setPhase("recording");
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

      const tx = await invoke<Transcript>("transcribe_audio", { audioPath: path });
      // Replace accumulated live segments with the final authoritative transcript
      setLiveSegments(tx.segments);
      setPhase("saving");

      const totalDuration = elapsedRef.current;
      const dateLabel = new Date().toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
      const result = await invoke<MeetingResult>("create_meeting", {
        args: {
          title: `Recording — ${dateLabel}`,
          audio_path: path,
          transcript: tx,
          duration_seconds: totalDuration > 0 ? totalDuration : null,
        },
      });

      // Save any notes that were added during recording
      for (const note of notes) {
        await invoke("add_manual_note", {
          args: {
            meeting_id: result.meeting_id,
            elapsed_seconds: note.elapsed,
            text: note.text,
          },
        });
      }

      if (selectedFolderId) {
        await invoke("update_meeting_folder", { meetingId: result.meeting_id, folderId: selectedFolderId });
      }
      setMeetingId(result.meeting_id);
      setPhase("done");
      window.dispatchEvent(new Event("scribe:reload-meetings"));
    } catch (e) {
      setError(String(e));
      setPhase("idle");
    }
  }

  async function handleImportAudio() {
    setError(null);
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: "Audio", extensions: ["mp3", "m4a", "wav", "aiff", "ogg", "flac"] }],
      });
      if (!selected || typeof selected !== "string") return;

      setPhase("transcribing");
      const result = await invoke<MeetingResult>("import_audio_file", { path: selected });
      if (selectedFolderId) {
        await invoke("update_meeting_folder", { meetingId: result.meeting_id, folderId: selectedFolderId });
      }
      setMeetingId(result.meeting_id);
      setPhase("done");
      window.dispatchEvent(new Event("scribe:reload-meetings"));
    } catch (e) {
      setError(String(e));
      setPhase("idle");
    }
  }

  function handleAddNote() {
    const text = noteInput.trim();
    if (!text) return;
    setNotes((prev) => [...prev, { elapsed: elapsedRef.current, text }]);
    setNoteInput("");
  }

  function handleOpenMeeting() {
    if (meetingId) onMeetingReady(meetingId);
  }

  function handleNewRecording() {
    setPhase("idle");
    setAudioPath(null);
    setLiveSegments([]);
    setNotes([]);
    setNoteInput("");
    setMeetingId(null);
    setElapsedSeconds(0);
    elapsedRef.current = 0;
  }

  // Global shortcut listener
  useEffect(() => {
    const handler = () => {
      if (phase === "idle" && asrOk && llmOk) handleStart();
      else if (phase === "recording" || phase === "paused") handleStop();
    };
    window.addEventListener("scribe:recording-shortcut", handler);
    return () => window.removeEventListener("scribe:recording-shortcut", handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, status]);

  const asrOk = status?.asr_ready ?? false;
  const llmOk = status?.llm_ready ?? false;
  const isRecording = phase === "recording";
  const isPaused = phase === "paused";
  const isDone = phase === "done";
  const isProcessing = phase === "transcribing" || phase === "saving";
  const isActive = isRecording || isPaused;

  return (
    <div className="flex flex-col h-full">
      {/* Top bar */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-gray-800">
        <h2 className="text-sm font-medium text-gray-300">New Recording</h2>
        <div className="flex items-center gap-4 text-xs">
          <StatusDot ok={asrOk} label="ASR" />
          <StatusDot
            ok={llmOk}
            label="LLM"
            title={status?.llm_error ?? undefined}
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6 space-y-5">
        {/* Error */}
        {error && (
          <div className="bg-red-900/50 border border-red-700 rounded-lg p-4 text-sm text-red-300 flex justify-between">
            <span>{error}</span>
            <button onClick={() => setError(null)} className="text-red-400 hover:text-white ml-4 shrink-0">✕</button>
          </div>
        )}

        {/* Controls */}
        <section className="bg-gray-900 border border-gray-800 rounded-xl p-6">
          <div className="flex items-center gap-4 flex-wrap">
            {phase === "idle" && (
              <>
                <button
                  onClick={handleStart}
                  disabled={!asrOk || !llmOk}
                  className="btn-primary disabled:opacity-40 disabled:cursor-not-allowed text-base px-6 py-3"
                >
                  <span className="text-red-400">●</span> Start Recording
                </button>
                <button
                  onClick={handleImportAudio}
                  disabled={!asrOk || !llmOk}
                  className="btn-ghost text-sm disabled:opacity-40"
                >
                  ↑ Import File
                </button>

                {/* Folder picker */}
                <div className="relative ml-auto" ref={folderPickerRef}>
                  {(() => {
                    const active = folders.find((f) => f.id === selectedFolderId);
                    return (
                      <button
                        onClick={() => setShowFolderPicker((v) => !v)}
                        className="flex items-center gap-1.5 text-xs rounded-full border border-gray-700 px-3 py-1.5 hover:border-gray-500 transition-colors"
                        style={active ? { borderColor: active.color + "66", color: active.color } : { color: "#6b7280" }}
                      >
                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                            d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
                        </svg>
                        {active ? active.name : "No folder"}
                        <svg className="w-3 h-3 opacity-60" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                        </svg>
                      </button>
                    );
                  })()}
                  {showFolderPicker && (
                    <div className="absolute right-0 top-full mt-1 z-20 bg-gray-800 border border-gray-700 rounded-lg shadow-xl py-1 min-w-[160px]">
                      <button
                        onClick={() => { setSelectedFolderId(null); setShowFolderPicker(false); }}
                        className="w-full text-left px-3 py-1.5 text-xs text-gray-400 hover:bg-gray-700"
                      >
                        No folder
                      </button>
                      {folders.map((f) => (
                        <button
                          key={f.id}
                          onClick={() => { setSelectedFolderId(f.id); setShowFolderPicker(false); }}
                          className="w-full text-left px-3 py-1.5 text-xs text-gray-200 hover:bg-gray-700 flex items-center gap-2"
                        >
                          <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: f.color }} />
                          {f.name}
                        </button>
                      ))}
                      {folders.length === 0 && (
                        <p className="px-3 py-2 text-xs text-gray-600">No folders yet</p>
                      )}
                    </div>
                  )}
                </div>
              </>
            )}
            {isRecording && (
              <>
                <button onClick={handlePause} className="btn-ghost">⏸ Pause</button>
                <button onClick={handleStop} className="btn-danger">■ Stop</button>
              </>
            )}
            {isPaused && (
              <>
                <button onClick={handleResume} className="btn-primary">▶ Resume</button>
                <button onClick={handleStop} className="btn-danger">■ Stop & Transcribe</button>
              </>
            )}
            {isProcessing && (
              <div className="flex items-center gap-3 text-gray-400 text-sm">
                <Spinner />
                {phase === "transcribing" ? "Transcribing audio…" : "Generating summary…"}
              </div>
            )}
            {isActive && (
              <span className={`font-mono text-2xl tabular-nums ml-auto ${isRecording ? "text-red-400" : "text-yellow-400"}`}>
                {isRecording ? "● " : "⏸ "}{formatTime(elapsedSeconds)}
              </span>
            )}
            {isDone && (
              <div className="flex items-center gap-3">
                <span className="text-emerald-400 text-sm">✓ Done</span>
                <button onClick={handleOpenMeeting} className="btn-primary">Open Meeting</button>
                <button onClick={handleNewRecording} className="btn-ghost">+ New Recording</button>
              </div>
            )}
          </div>

          {/* Audio level meter */}
          {isActive && (
            <div className="mt-3 flex items-center gap-2">
              <span className="text-[10px] text-gray-600 uppercase tracking-widest shrink-0">Level</span>
              <div className="flex-1 h-2 bg-gray-800 rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-75"
                  style={{
                    width: `${Math.min(100, audioLevel * 400)}%`,
                    background: audioLevel > 0.5 ? "#ef4444" : "#22c55e",
                  }}
                />
              </div>
            </div>
          )}

          {!asrOk && phase === "idle" && (
            <p className="mt-3 text-xs text-amber-500">ASR model is loading — wait before recording.</p>
          )}
          {status?.llm_error && (
            <p className="mt-3 text-xs text-red-400">{status.llm_error}</p>
          )}
        </section>

        {/* Notes input during recording */}
        {isActive && (
          <section className="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <p className="text-xs text-gray-500 mb-2 uppercase tracking-widest">Notes</p>
            <div className="flex gap-2">
              <input
                type="text"
                value={noteInput}
                onChange={(e) => setNoteInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleAddNote()}
                placeholder="Type a note and press Enter…"
                className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
              <button onClick={handleAddNote} className="btn-secondary">Add</button>
            </div>
            {notes.length > 0 && (
              <div className="mt-3 space-y-1">
                {notes.map((n, i) => (
                  <div key={i} className="flex gap-2 text-xs text-gray-400">
                    <span className="font-mono text-gray-600 shrink-0">{formatTime(n.elapsed)}</span>
                    <span>{n.text}</span>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {/* Live / final transcript */}
        {liveSegments.length > 0 && (
          <section className="bg-gray-900 border border-gray-800 rounded-xl p-5">
            <p className="text-xs text-gray-500 mb-3 uppercase tracking-widest flex items-center gap-2">
              Transcript
              {isProcessing && <Spinner className="h-3 w-3" />}
            </p>
            <div className="max-h-72 overflow-y-auto space-y-1 pr-1">
              {liveSegments.map((seg, i) => (
                <div key={i} className="flex gap-3 text-sm">
                  <span className="text-gray-600 font-mono shrink-0 w-14 text-right">
                    {formatTime(Math.floor(seg.start))}
                  </span>
                  <span className="text-gray-300">{seg.text}</span>
                </div>
              ))}
              <div ref={transcriptEndRef} />
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
