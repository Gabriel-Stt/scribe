import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  MeetingDetail,
  SummaryVersionItem,
  StoredChatMessage,
  SUBJECT_TAGS,
} from "../lib/types";
import { formatTime, Spinner, MarkdownBody, SubjectPill } from "./shared";

type Tab = "summary" | "transcript" | "chat";

interface Props {
  meetingId: string;
  onDeleted: () => void;
}

export default function MeetingView({ meetingId, onDeleted }: Props) {
  const [detail, setDetail] = useState<MeetingDetail | null>(null);
  const [tab, setTab] = useState<Tab>("summary");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Inline title editing
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");

  // Summary
  const [currentSummary, setCurrentSummary] = useState("");
  const [showVersions, setShowVersions] = useState(false);
  const [resummaryInput, setResummaryInput] = useState("");
  const [summaryBusy, setSummaryBusy] = useState(false);

  // Chat
  const [chatHistory, setChatHistory] = useState<StoredChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [streamingContent, setStreamingContent] = useState<string | null>(null);
  const [chatBusy, setChatBusy] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Export
  const [exportBusy, setExportBusy] = useState(false);

  const loadDetail = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const d = await invoke<MeetingDetail>("get_meeting_detail", { meetingId });
      setDetail(d);
      const latest = d.summaries[0]?.content ?? "";
      setCurrentSummary(latest);
      setChatHistory(d.chat_messages as StoredChatMessage[]);
      setTitleDraft(d.title);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [meetingId]);

  useEffect(() => {
    loadDetail();
    setTab("summary");
    setShowVersions(false);
    setResummaryInput("");
    setStreamingContent(null);
  }, [loadDetail]);

  // Listen for auto-generated title updates
  useEffect(() => {
    const unsub = listen<[string, string]>("meeting-title-ready", (e) => {
      const [id, title] = e.payload;
      if (id === meetingId) {
        setDetail((d) => d ? { ...d, title } : d);
        setTitleDraft(title);
        window.dispatchEvent(new Event("scribe:reload-meetings"));
      }
    });
    return () => { unsub.then((u) => u()); };
  }, [meetingId]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatHistory, streamingContent]);

  // ---- Title editing ----

  async function saveTitle() {
    if (!detail || !titleDraft.trim()) { setEditingTitle(false); return; }
    setEditingTitle(false);
    await invoke("update_meeting", { args: { id: meetingId, title: titleDraft.trim(), subject_tag: null } });
    setDetail((d) => d ? { ...d, title: titleDraft.trim() } : d);
    window.dispatchEvent(new Event("scribe:reload-meetings"));
  }

  // ---- Subject tag ----

  async function handleSubjectChange(tag: string) {
    await invoke("update_meeting", {
      args: { id: meetingId, title: null, subject_tag: tag },
    });
    setDetail((d) => d ? { ...d, subject_tag: tag || null } : d);
    window.dispatchEvent(new Event("scribe:reload-meetings"));
  }

  // ---- Resummary ----

  async function handleResummary() {
    if (!resummaryInput.trim()) return;
    setSummaryBusy(true);
    try {
      const newSummary = await invoke<string>("resummmarize", {
        args: { meeting_id: meetingId, instruction: resummaryInput.trim() },
      });
      setCurrentSummary(newSummary);
      setResummaryInput("");
      // Refresh summaries list
      const d = await invoke<MeetingDetail>("get_meeting_detail", { meetingId });
      setDetail(d);
    } catch (e) {
      setError(String(e));
    } finally {
      setSummaryBusy(false);
    }
  }

  async function handleRestoreVersion(v: SummaryVersionItem) {
    setSummaryBusy(true);
    try {
      const content = await invoke<string>("restore_summary", {
        meetingId,
        version: v.version,
      });
      setCurrentSummary(content);
      setShowVersions(false);
      const d = await invoke<MeetingDetail>("get_meeting_detail", { meetingId });
      setDetail(d);
    } catch (e) {
      setError(String(e));
    } finally {
      setSummaryBusy(false);
    }
  }

  // ---- Chat ----

  async function handleChat() {
    if (!chatInput.trim()) return;
    const msg = chatInput.trim();
    setChatInput("");
    setChatHistory((h) => [...h, { role: "user", content: msg }]);
    setStreamingContent("");
    setChatBusy(true);

    const unlisten = await listen<string>("chat-chunk", (e) => {
      setStreamingContent((prev) => (prev ?? "") + e.payload);
    });

    try {
      const resp = await invoke<{ response: string }>("send_chat_message", {
        args: { meeting_id: meetingId, message: msg },
      });
      setChatHistory((h) => [...h, { role: "assistant", content: resp.response }]);
    } catch (e) {
      setError(String(e));
    } finally {
      unlisten();
      setStreamingContent(null);
      setChatBusy(false);
    }
  }

  // ---- Export ----

  async function handleExport() {
    setExportBusy(true);
    try {
      const md = await invoke<string>("export_meeting_markdown", { meetingId });
      const blob = new Blob([md], { type: "text/markdown" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${(detail?.title ?? "meeting").replace(/[^\w\s-]/g, "")}.md`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(String(e));
    } finally {
      setExportBusy(false);
    }
  }

  // ---- Delete ----

  async function handleDelete() {
    if (!confirm("Delete this recording and all its data? This cannot be undone.")) return;
    try {
      await invoke("delete_meeting", { meetingId });
      window.dispatchEvent(new Event("scribe:reload-meetings"));
      onDeleted();
    } catch (e) {
      setError(String(e));
    }
  }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-600">
        <Spinner className="h-6 w-6" />
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-600 text-sm">
        {error ?? "Meeting not found"}
      </div>
    );
  }

  const sortedTranscript = [...detail.segments].sort((a, b) => a.start - b.start);
  // Interleave notes into transcript for display
  type TranscriptEntry =
    | { kind: "segment"; start: number; end: number; text: string }
    | { kind: "note"; elapsed_seconds: number; text: string };

  const transcriptEntries: TranscriptEntry[] = [
    ...sortedTranscript.map((s) => ({ kind: "segment" as const, ...s })),
    ...detail.notes.map((n) => ({ kind: "note" as const, elapsed_seconds: n.elapsed_seconds, text: n.text })),
  ].sort((a, b) => {
    const ta = a.kind === "segment" ? a.start : a.elapsed_seconds;
    const tb = b.kind === "segment" ? b.start : b.elapsed_seconds;
    return ta - tb;
  });

  return (
    <div className="flex flex-col h-full">
      {/* Meeting header */}
      <div className="px-6 py-4 border-b border-gray-800 flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          {editingTitle ? (
            <input
              autoFocus
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={saveTitle}
              onKeyDown={(e) => { if (e.key === "Enter") saveTitle(); if (e.key === "Escape") setEditingTitle(false); }}
              className="w-full bg-gray-800 border border-indigo-500 rounded px-2 py-1 text-base font-semibold text-white focus:outline-none"
            />
          ) : (
            <h1
              className="text-base font-semibold text-white cursor-text hover:text-indigo-300 transition-colors truncate"
              title="Click to edit title"
              onClick={() => setEditingTitle(true)}
            >
              {detail.title}
            </h1>
          )}
          <div className="flex items-center gap-3 mt-1">
            <span className="text-xs text-gray-600">{formatDateLong(detail.created_at)}</span>
            {detail.duration_seconds != null && (
              <span className="text-xs text-gray-700">{formatTime(detail.duration_seconds)}</span>
            )}
            <SubjectPill tag={detail.subject_tag} />
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {/* Subject tag selector */}
          <select
            value={detail.subject_tag ?? ""}
            onChange={(e) => handleSubjectChange(e.target.value)}
            className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1 text-xs text-gray-300 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          >
            <option value="">No tag</option>
            {SUBJECT_TAGS.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
          <button
            onClick={handleExport}
            disabled={exportBusy}
            className="btn-ghost text-xs px-3 py-1.5"
            title="Export to Markdown"
          >
            {exportBusy ? <Spinner /> : "↓ Export"}
          </button>
          <button
            onClick={handleDelete}
            className="p-1.5 text-gray-600 hover:text-red-400 transition-colors"
            title="Delete meeting"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
                d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </button>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="mx-6 mt-3 bg-red-900/50 border border-red-700 rounded-lg p-3 text-xs text-red-300 flex justify-between">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="ml-3 shrink-0">✕</button>
        </div>
      )}

      {/* Tabs */}
      <div className="flex border-b border-gray-800 px-6">
        {(["summary", "transcript", "chat"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2.5 text-sm font-medium capitalize transition-colors border-b-2 -mb-px ${
              tab === t
                ? "border-indigo-500 text-white"
                : "border-transparent text-gray-500 hover:text-gray-300"
            }`}
          >
            {t}
            {t === "chat" && chatHistory.length > 0 && (
              <span className="ml-1.5 text-xs bg-gray-700 text-gray-400 rounded-full px-1.5">
                {chatHistory.length}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto p-6">
        {/* ----- Summary ----- */}
        {tab === "summary" && (
          <div className="space-y-4">
            {currentSummary ? (
              <MarkdownBody>{currentSummary}</MarkdownBody>
            ) : (
              <p className="text-sm text-gray-600 italic">No summary yet.</p>
            )}

            {/* Resummary input */}
            <div className="pt-4 border-t border-gray-800 flex gap-2">
              <input
                type="text"
                value={resummaryInput}
                onChange={(e) => setResummaryInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleResummary()}
                placeholder="Re-summarize with different instructions…"
                className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
              <button
                onClick={handleResummary}
                disabled={summaryBusy || !resummaryInput.trim()}
                className="btn-secondary disabled:opacity-40"
              >
                {summaryBusy ? <Spinner /> : "Regenerate"}
              </button>
              <button
                onClick={() => {
                  if (resummaryInput.trim()) {
                    invoke("save_preference", { instruction: resummaryInput.trim() });
                    setResummaryInput("");
                  }
                }}
                disabled={!resummaryInput.trim()}
                className="btn-ghost text-xs disabled:opacity-40"
                title="Save to context.md as a default"
              >
                Save pref
              </button>
            </div>

            {/* Version history */}
            {detail.summaries.length > 1 && (
              <div className="pt-2">
                <button
                  onClick={() => setShowVersions((v) => !v)}
                  className="text-xs text-gray-600 hover:text-gray-400 transition-colors"
                >
                  {showVersions ? "▲ Hide" : "▼ Show"} {detail.summaries.length} versions
                </button>
                {showVersions && (
                  <div className="mt-3 space-y-3">
                    {detail.summaries.map((sv) => (
                      <div
                        key={sv.version}
                        className="bg-gray-900 border border-gray-800 rounded-lg p-3"
                      >
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-xs text-gray-600">v{sv.version} · {formatDateLong(sv.created_at)}</span>
                          {sv.content !== currentSummary && (
                            <button
                              onClick={() => handleRestoreVersion(sv)}
                              className="text-xs text-indigo-400 hover:text-indigo-300"
                            >
                              Restore
                            </button>
                          )}
                          {sv.content === currentSummary && (
                            <span className="text-xs text-emerald-600">Current</span>
                          )}
                        </div>
                        <p className="text-xs text-gray-500 line-clamp-3">{sv.content}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ----- Transcript ----- */}
        {tab === "transcript" && (
          <div className="space-y-1">
            {transcriptEntries.length === 0 && (
              <p className="text-sm text-gray-600 italic">No transcript available.</p>
            )}
            {transcriptEntries.map((entry, i) =>
              entry.kind === "segment" ? (
                <div key={i} className="flex gap-3 text-sm py-0.5">
                  <span className="text-gray-600 font-mono shrink-0 w-14 text-right">
                    {formatTime(Math.floor(entry.start))}
                  </span>
                  <span className="text-gray-300">{entry.text}</span>
                </div>
              ) : (
                <div key={i} className="flex gap-3 text-sm py-1 bg-yellow-900/20 rounded px-2 my-1">
                  <span className="text-yellow-700 font-mono shrink-0 w-14 text-right">
                    {formatTime(Math.floor(entry.elapsed_seconds))}
                  </span>
                  <span className="text-yellow-300/80 italic">{entry.text}</span>
                  <span className="text-yellow-700 text-xs ml-auto shrink-0">note</span>
                </div>
              )
            )}
          </div>
        )}

        {/* ----- Chat ----- */}
        {tab === "chat" && (
          <div className="flex flex-col h-full gap-4">
            <div className="flex-1 min-h-0 overflow-y-auto space-y-3 pr-1">
              {chatHistory.length === 0 && !streamingContent && (
                <p className="text-gray-600 text-sm italic">Ask a question about this recording…</p>
              )}
              {chatHistory.map((msg, i) => (
                <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                  <div
                    className={`max-w-[85%] rounded-xl px-4 py-2 text-sm ${
                      msg.role === "user"
                        ? "bg-indigo-600 text-white"
                        : "bg-gray-800 text-gray-200"
                    }`}
                  >
                    {msg.role === "assistant" ? (
                      <MarkdownBody>{msg.content}</MarkdownBody>
                    ) : (
                      <span className="whitespace-pre-wrap">{msg.content}</span>
                    )}
                  </div>
                </div>
              ))}
              {streamingContent !== null && (
                <div className="flex justify-start">
                  <div className="max-w-[85%] bg-gray-800 text-gray-200 rounded-xl px-4 py-2 text-sm">
                    <MarkdownBody>{streamingContent || " "}</MarkdownBody>
                    <span className="inline-block w-1.5 h-3.5 bg-gray-400 animate-pulse align-middle ml-0.5" />
                  </div>
                </div>
              )}
              <div ref={chatEndRef} />
            </div>
            <div className="flex gap-2 pt-2 border-t border-gray-800 shrink-0">
              <input
                type="text"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handleChat()}
                placeholder="Ask a question…"
                className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
              <button
                onClick={handleChat}
                disabled={chatBusy || !chatInput.trim()}
                className="btn-primary disabled:opacity-40"
              >
                Send
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function formatDateLong(isoStr: string): string {
  try {
    const d = new Date(isoStr.replace(" ", "T") + "Z");
    return d.toLocaleString(undefined, {
      month: "short", day: "numeric", year: "numeric",
      hour: "numeric", minute: "2-digit",
    });
  } catch {
    return isoStr;
  }
}
