import { useState, useEffect, useRef, useCallback } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import {
  MeetingDetail,
  SummaryVersionItem,
  StoredChatMessage,
  Folder,
  UserTag,
  ActionItem,
  NoteFile,
  AppView,
} from "../lib/types";
import { formatTime, Spinner, MarkdownBody } from "./shared";

function markdownToHtml(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let inList = false;

  for (const rawLine of lines) {
    const line = rawLine;

    // Horizontal rule
    if (/^-{3,}$/.test(line.trim()) || /^\*{3,}$/.test(line.trim())) {
      if (inList) { out.push("</ul>"); inList = false; }
      out.push("<hr>");
      continue;
    }

    // Headings
    const h3 = line.match(/^### (.+)/);
    const h2 = line.match(/^## (.+)/);
    const h1 = line.match(/^# (.+)/);
    if (h3 || h2 || h1) {
      if (inList) { out.push("</ul>"); inList = false; }
      const lvl = h1 ? 1 : h2 ? 2 : 3;
      const text = inlineFormat((h1 ?? h2 ?? h3)![1]);
      out.push(`<h${lvl}>${text}</h${lvl}>`);
      continue;
    }

    // Bullet list
    const bullet = line.match(/^[-*] (.+)/);
    if (bullet) {
      if (!inList) { out.push("<ul>"); inList = true; }
      out.push(`<li>${inlineFormat(bullet[1])}</li>`);
      continue;
    }

    // Close list on non-bullet
    if (inList) { out.push("</ul>"); inList = false; }

    // Empty line → paragraph break (skip, already handled by wrapping)
    if (line.trim() === "") {
      out.push("<br>");
      continue;
    }

    // Regular paragraph line
    out.push(`<p>${inlineFormat(line)}</p>`);
  }

  if (inList) out.push("</ul>");
  return out.join("\n");
}

function inlineFormat(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/_(.+?)_/g, "<em>$1</em>")
    .replace(/`(.+?)`/g, "<code>$1</code>");
}

const TAG_COLORS = [
  "#ef4444", "#f97316", "#eab308", "#22c55e",
  "#14b8a6", "#3b82f6", "#8b5cf6", "#ec4899",
  "#06b6d4", "#6b7280",
];

type Tab = "summary" | "transcript" | "todo" | "chat";

interface Props {
  meetingId: string;
  onDeleted: () => void;
  onNavigate?: (view: AppView) => void;
}

export default function MeetingView({ meetingId, onDeleted, onNavigate }: Props) {
  const [detail, setDetail] = useState<MeetingDetail | null>(null);
  const [tab, setTab] = useState<Tab>("summary");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Inline title editing
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");

  // Summary
  const [currentSummary, setCurrentSummary] = useState("");
  const [activeSummaryVersion, setActiveSummaryVersion] = useState<number | null>(null);
  const [showVersions, setShowVersions] = useState(false);
  const [resummaryInput, setResummaryInput] = useState("");
  const [summaryBusy, setSummaryBusy] = useState(false);
  const [copiedSummary, setCopiedSummary] = useState(false);

  // Chat
  const [chatHistory, setChatHistory] = useState<StoredChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [streamingContent, setStreamingContent] = useState<string | null>(null);
  const [chatBusy, setChatBusy] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Folders & tags
  const [folders, setFolders] = useState<Folder[]>([]);
  const [userTags, setUserTags] = useState<UserTag[]>([]);

  // Export
  const [exportBusy, setExportBusy] = useState(false);

  // Audio player
  const audioRef = useRef<HTMLAudioElement>(null);
  const [audioPlaying, setAudioPlaying] = useState(false);
  const [audioTime, setAudioTime] = useState(0);
  const [audioDuration, setAudioDuration] = useState(0);
  const [activeSegmentIdx, setActiveSegmentIdx] = useState<number | null>(null);

  // Action items
  const [actionItems, setActionItems] = useState<ActionItem[]>([]);
  const [actionsBusy, setActionsBusy] = useState(false);

  // Notes for "send to note" picker
  const [allNotes, setAllNotes] = useState<NoteFile[]>([]);
  const [showSendToNotePicker, setShowSendToNotePicker] = useState(false);
  const sendToNotePickerRef = useRef<HTMLDivElement>(null);

  // Tag editing
  const [showTagDropdown, setShowTagDropdown] = useState(false);
  const [createTagName, setCreateTagName] = useState("");
  const [createTagColor, setCreateTagColor] = useState(TAG_COLORS[0]);
  const [showCreateTag, setShowCreateTag] = useState(false);
  const tagDropdownRef = useRef<HTMLDivElement>(null);

  const loadDetail = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const d = await invoke<MeetingDetail>("get_meeting_detail", { meetingId });
      setDetail(d);
      const activeVer = d.active_summary_version;
      setActiveSummaryVersion(activeVer);
      const activeSummary = activeVer != null
        ? (d.summaries.find((s) => s.version === activeVer)?.content ?? d.summaries[0]?.content ?? "")
        : (d.summaries[0]?.content ?? "");
      setCurrentSummary(activeSummary);
      setChatHistory(d.chat_messages as StoredChatMessage[]);
      setTitleDraft(d.title);
      setActionItems(d.action_items ?? []);
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

  useEffect(() => {
    invoke<Folder[]>("list_folders").then(setFolders).catch(() => {});
    invoke<UserTag[]>("list_tags").then(setUserTags).catch(() => {});
    invoke<NoteFile[]>("list_notes", { search: null, folderId: null }).then(setAllNotes).catch(() => {});
  }, []);

  useEffect(() => {
    if (!showSendToNotePicker) return;
    const h = (e: MouseEvent) => {
      if (sendToNotePickerRef.current && !sendToNotePickerRef.current.contains(e.target as Node))
        setShowSendToNotePicker(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [showSendToNotePicker]);

  // Listen for folder/tag changes from sidebar
  useEffect(() => {
    const handler = () => {
      invoke<Folder[]>("list_folders").then(setFolders).catch(() => {});
    };
    window.addEventListener("scribe:reload-meetings", handler);
    return () => window.removeEventListener("scribe:reload-meetings", handler);
  }, []);

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

  useEffect(() => {
    if (!showTagDropdown) return;
    const handler = (e: MouseEvent) => {
      if (tagDropdownRef.current && !tagDropdownRef.current.contains(e.target as Node)) {
        setShowTagDropdown(false);
        setShowCreateTag(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showTagDropdown]);

  // ---- Title editing ----

  async function saveTitle() {
    if (!detail || !titleDraft.trim()) { setEditingTitle(false); return; }
    setEditingTitle(false);
    await invoke("update_meeting", { args: { id: meetingId, title: titleDraft.trim() } });
    setDetail((d) => d ? { ...d, title: titleDraft.trim() } : d);
    window.dispatchEvent(new Event("scribe:reload-meetings"));
  }

  // ---- Tags ----

  async function handleSetMeetingTags(tagIds: string[]) {
    await invoke("set_meeting_tags", { meetingId, tagIds });
    setDetail((d) => d ? { ...d, tags: userTags.filter((t) => tagIds.includes(t.id)) } : d);
    window.dispatchEvent(new Event("scribe:reload-meetings"));
  }

  async function handleAddTag(tagId: string) {
    if (!detail || detail.tags.some((t) => t.id === tagId)) return;
    await handleSetMeetingTags([...detail.tags.map((t) => t.id), tagId]);
  }

  async function handleRemoveTag(tagId: string) {
    if (!detail) return;
    await handleSetMeetingTags(detail.tags.map((t) => t.id).filter((id) => id !== tagId));
  }

  async function handleCreateAndAddTag() {
    if (!createTagName.trim() || !detail) return;
    try {
      const tag = await invoke<UserTag>("create_tag", {
        args: { name: createTagName.trim(), color: createTagColor },
      });
      const refreshed = await invoke<UserTag[]>("list_tags");
      setUserTags(refreshed);
      await handleSetMeetingTags([...detail.tags.map((t) => t.id), tag.id]);
      setCreateTagName("");
      setShowCreateTag(false);
      setShowTagDropdown(false);
    } catch { /* ignore */ }
  }

  // ---- Folder ----

  async function handleFolderChange(folderId: string) {
    await invoke("assign_meeting_folder", {
      meetingId,
      folderId: folderId || null,
    });
    setDetail((d) => d ? { ...d, folder_id: folderId || null } : d);
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
      const d = await invoke<MeetingDetail>("get_meeting_detail", { meetingId });
      setDetail(d);
      setActiveSummaryVersion(d.active_summary_version);
    } catch (e) {
      setError(String(e));
    } finally {
      setSummaryBusy(false);
    }
  }

  async function handleRestoreVersion(v: SummaryVersionItem) {
    setSummaryBusy(true);
    try {
      await invoke<string>("restore_summary", {
        meetingId,
        version: v.version,
      });
      setCurrentSummary(v.content);
      setActiveSummaryVersion(v.version);
      setShowVersions(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setSummaryBusy(false);
    }
  }

  async function handleCopySummary() {
    try {
      await navigator.clipboard.writeText(currentSummary);
      setCopiedSummary(true);
      setTimeout(() => setCopiedSummary(false), 2000);
    } catch { /* ignore */ }
  }

  const [sendToNoteBusy, setSendToNoteBusy] = useState(false);

  async function handleSendToNote(noteId: string | null) {
    if (!currentSummary || sendToNoteBusy) return;
    setShowSendToNotePicker(false);
    setSendToNoteBusy(true);
    try {
      const summaryHtml = markdownToHtml(currentSummary);
      let resolvedNoteId: string;
      if (noteId === null) {
        const note = await invoke<NoteFile>("create_note");
        const title = detail ? `Summary — ${detail.title}` : "Meeting Summary";
        await invoke("save_note", { args: { note_id: note.id, title, content: summaryHtml } });
        resolvedNoteId = note.id;
      } else {
        const existing = await invoke<NoteFile | null>("get_note", { noteId });
        const current = existing?.content ?? "";
        const separator = current ? `<hr>` : "";
        await invoke("save_note", { args: { note_id: noteId, title: null, content: current + separator + summaryHtml } });
        resolvedNoteId = noteId;
      }
      window.dispatchEvent(new Event("scribe:reload-notes"));
      onNavigate?.({ kind: "split", left: { kind: "meeting", id: meetingId }, right: { kind: "note", id: resolvedNoteId } });
    } catch { /* ignore */ }
    finally { setSendToNoteBusy(false); }
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
      const safeName = (detail?.title ?? "meeting").replace(/[^\w\s\-]/g, "").trim();
      const path = await save({
        defaultPath: `${safeName}.md`,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (!path) return;
      const md = await invoke<string>("export_meeting_markdown", { meetingId });
      await invoke("write_text_file", { path, content: md });
    } catch (e) {
      setError(String(e));
    } finally {
      setExportBusy(false);
    }
  }

  // ---- Action items ----

  async function handleExtractActions() {
    setActionsBusy(true);
    try {
      const items = await invoke<ActionItem[]>("extract_action_items", { meetingId });
      setActionItems(items);
    } catch (e) { setError(String(e)); }
    finally { setActionsBusy(false); }
  }

  async function handleToggleAction(idx: number) {
    const updated = actionItems.map((a, i) => i === idx ? { ...a, done: !a.done } : a);
    setActionItems(updated);
    await invoke("save_action_items", { args: { meeting_id: meetingId, items: updated } });
  }

  async function handleDeleteAction(idx: number) {
    const updated = actionItems.filter((_, i) => i !== idx);
    setActionItems(updated);
    await invoke("save_action_items", { args: { meeting_id: meetingId, items: updated } });
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

  const activeFolder = folders.find((f) => f.id === detail.folder_id);

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
            <div className="flex items-center gap-2">
              <h1
                className="text-base font-semibold text-white cursor-text hover:text-indigo-300 transition-colors truncate"
                title="Click to rename"
                onClick={() => setEditingTitle(true)}
              >
                {detail.title}
              </h1>
              <button
                onClick={() => setEditingTitle(true)}
                className="shrink-0 text-gray-600 hover:text-gray-400 transition-colors"
                title="Rename"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                </svg>
              </button>
            </div>
          )}
          <div className="flex items-center gap-3 mt-1 flex-wrap">
            <span className="text-xs text-gray-600">{formatDateLong(detail.created_at)}</span>
            {detail.duration_seconds != null && (
              <span className="text-xs text-gray-700">{formatTime(detail.duration_seconds)}</span>
            )}
            {activeFolder && (
              <span
                className="text-xs px-2 py-0.5 rounded-full font-medium flex items-center gap-1"
                style={{ background: activeFolder.color + "33", color: activeFolder.color }}
              >
                <span className="w-1.5 h-1.5 rounded-sm" style={{ background: activeFolder.color }} />
                {activeFolder.name}
              </span>
            )}
            {detail.tags.map((tag) => (
              <span
                key={tag.id}
                className="group relative text-xs px-2 py-0.5 rounded-full font-medium flex items-center gap-1"
                style={{ background: tag.color + "33", color: tag.color }}
              >
                {tag.name}
                <button
                  onClick={() => handleRemoveTag(tag.id)}
                  className="opacity-0 group-hover:opacity-100 text-[10px] leading-none transition-opacity hover:text-white"
                  title="Remove tag"
                >✕</button>
              </span>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">
          {/* Folder selector */}
          <select
            value={detail.folder_id ?? ""}
            onChange={(e) => handleFolderChange(e.target.value)}
            className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1 text-xs text-gray-300 focus:outline-none focus:ring-1 focus:ring-indigo-500 max-w-[110px]"
          >
            <option value="">No folder</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>{f.name}</option>
            ))}
          </select>

          {/* Tag picker */}
          <div className="relative" ref={tagDropdownRef}>
            <button
              onClick={() => { setShowTagDropdown((v) => !v); setShowCreateTag(false); }}
              className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1 text-xs text-gray-300 hover:border-gray-600 transition-colors focus:outline-none"
            >
              Tags{detail.tags.length > 0 ? ` (${detail.tags.length})` : ""}
            </button>
            {showTagDropdown && (
              <div className="absolute right-0 top-full mt-1 z-20 bg-gray-800 border border-gray-700 rounded-lg shadow-xl py-1 min-w-[160px]">
                <div className="max-h-48 overflow-y-auto">
                  {userTags.map((tag) => {
                    const checked = detail.tags.some((t) => t.id === tag.id);
                    return (
                      <button
                        key={tag.id}
                        className="w-full text-left px-3 py-1.5 text-xs text-gray-200 hover:bg-gray-700 flex items-center gap-2"
                        onClick={() => checked ? handleRemoveTag(tag.id) : handleAddTag(tag.id)}
                      >
                        <span
                          className="w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0 text-[8px] font-bold text-white"
                          style={checked
                            ? { background: tag.color, borderColor: tag.color }
                            : { borderColor: "#4b5563" }}
                        >
                          {checked ? "✓" : ""}
                        </span>
                        <span className="flex-1 truncate">{tag.name}</span>
                        <span className="w-2 h-2 rounded-full shrink-0" style={{ background: tag.color }} />
                      </button>
                    );
                  })}
                </div>
                {showCreateTag ? (
                  <div className="px-3 py-2 space-y-1.5 border-t border-gray-700 mt-1">
                    <input
                      autoFocus
                      value={createTagName}
                      onChange={(e) => setCreateTagName(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") handleCreateAndAddTag(); if (e.key === "Escape") setShowCreateTag(false); }}
                      placeholder="Tag name…"
                      className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1 text-xs text-white placeholder-gray-500 focus:outline-none"
                    />
                    <div className="flex gap-1 flex-wrap">
                      {TAG_COLORS.map((c) => (
                        <button
                          key={c}
                          onClick={() => setCreateTagColor(c)}
                          className={`w-3.5 h-3.5 rounded-full ${createTagColor === c ? "ring-1 ring-white" : ""}`}
                          style={{ background: c }}
                        />
                      ))}
                    </div>
                    <div className="flex gap-1">
                      <button onClick={handleCreateAndAddTag} className="flex-1 text-[10px] py-1 bg-indigo-600 hover:bg-indigo-700 text-white rounded">Create</button>
                      <button onClick={() => setShowCreateTag(false)} className="text-[10px] py-1 px-2 text-gray-500 hover:text-gray-300">Cancel</button>
                    </div>
                  </div>
                ) : (
                  <button
                    className="w-full text-left px-3 py-1.5 text-xs text-gray-500 hover:bg-gray-700 flex items-center gap-1.5 border-t border-gray-700 mt-1"
                    onClick={() => setShowCreateTag(true)}
                  >
                    <span className="text-sm leading-none">+</span>
                    New tag…
                  </button>
                )}
              </div>
            )}
          </div>

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

      {/* Audio player */}
      {detail.audio_path && (
        <div className="px-6 py-2 border-b border-gray-800 flex items-center gap-3 bg-gray-900/60">
          <audio
            ref={audioRef}
            src={convertFileSrc(detail.audio_path)}
            onTimeUpdate={() => {
              const t = audioRef.current?.currentTime ?? 0;
              setAudioTime(t);
              const idx = sortedTranscript.findIndex((s, i) => {
                const next = sortedTranscript[i + 1];
                return t >= s.start && (next == null || t < next.start);
              });
              setActiveSegmentIdx(idx >= 0 ? idx : null);
            }}
            onLoadedMetadata={() => setAudioDuration(audioRef.current?.duration ?? 0)}
            onPlay={() => setAudioPlaying(true)}
            onPause={() => setAudioPlaying(false)}
            onEnded={() => setAudioPlaying(false)}
          />
          <button
            onClick={() => audioPlaying ? audioRef.current?.pause() : audioRef.current?.play()}
            className="w-7 h-7 rounded-full bg-indigo-600 hover:bg-indigo-500 flex items-center justify-center shrink-0 transition-colors"
          >
            {audioPlaying ? (
              <svg className="w-3 h-3 text-white" fill="currentColor" viewBox="0 0 24 24">
                <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
              </svg>
            ) : (
              <svg className="w-3 h-3 text-white ml-0.5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M8 5v14l11-7z" />
              </svg>
            )}
          </button>
          <span className="text-[10px] text-gray-500 font-mono shrink-0 w-10">
            {formatTime(Math.floor(audioTime))}
          </span>
          <div
            className="flex-1 h-1.5 bg-gray-800 rounded-full cursor-pointer relative"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const pct = (e.clientX - rect.left) / rect.width;
              if (audioRef.current) audioRef.current.currentTime = pct * audioDuration;
            }}
          >
            <div
              className="h-full bg-indigo-500 rounded-full transition-all"
              style={{ width: audioDuration > 0 ? `${(audioTime / audioDuration) * 100}%` : "0%" }}
            />
          </div>
          <span className="text-[10px] text-gray-600 font-mono shrink-0 w-10 text-right">
            {formatTime(Math.floor(audioDuration))}
          </span>
        </div>
      )}

      {/* Error banner */}
      {error && (
        <div className="mx-6 mt-3 bg-red-900/50 border border-red-700 rounded-lg p-3 text-xs text-red-300 flex justify-between">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="ml-3 shrink-0">✕</button>
        </div>
      )}

      {/* Tabs */}
      <div className="flex border-b border-gray-800 px-6">
        {(["summary", "transcript", "todo", "chat"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3 py-2.5 text-sm font-medium capitalize transition-colors border-b-2 -mb-px ${
              tab === t
                ? "border-indigo-500 text-white"
                : "border-transparent text-gray-500 hover:text-gray-300"
            }`}
          >
            {t === "todo" ? "To-do" : t}
            {t === "todo" && actionItems.length > 0 && (
              <span className="ml-1.5 text-xs bg-gray-700 text-gray-400 rounded-full px-1.5">
                {actionItems.filter((a) => !a.done).length}
              </span>
            )}
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
              <>
                <div className="flex justify-end items-center gap-3">
                  {/* Send to note dropdown */}
                  <div className="relative" ref={sendToNotePickerRef}>
                    <button
                      onClick={() => setShowSendToNotePicker((v) => !v)}
                      disabled={sendToNoteBusy}
                      className="text-xs text-gray-500 hover:text-gray-300 flex items-center gap-1.5 transition-colors disabled:opacity-40"
                      title="Send summary to a note"
                    >
                      {sendToNoteBusy ? <Spinner /> : (
                        <>
                          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
                              d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                          </svg>
                          Send to note
                        </>
                      )}
                    </button>
                    {showSendToNotePicker && (
                      <div className="absolute right-0 top-full mt-1 z-20 bg-gray-800 border border-gray-700 rounded-lg shadow-xl py-1 min-w-[200px] max-h-60 overflow-y-auto">
                        <button
                          onClick={() => handleSendToNote(null)}
                          className="w-full text-left px-3 py-2 text-xs text-indigo-300 hover:bg-gray-700 flex items-center gap-2 border-b border-gray-700/60"
                        >
                          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                          </svg>
                          New note
                        </button>
                        {allNotes.length === 0 ? (
                          <p className="px-3 py-2 text-xs text-gray-600">No existing notes</p>
                        ) : (
                          allNotes.map((n) => (
                            <button
                              key={n.id}
                              onClick={() => handleSendToNote(n.id)}
                              className="w-full text-left px-3 py-1.5 text-xs text-gray-200 hover:bg-gray-700 truncate block"
                            >
                              {n.title}
                            </button>
                          ))
                        )}
                      </div>
                    )}
                  </div>

                  {/* Copy */}
                  <button
                    onClick={handleCopySummary}
                    className="text-xs text-gray-500 hover:text-gray-300 flex items-center gap-1.5 transition-colors"
                    title="Copy summary to clipboard"
                  >
                    {copiedSummary ? (
                      <>
                        <svg className="w-3.5 h-3.5 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                        </svg>
                        <span className="text-emerald-400">Copied</span>
                      </>
                    ) : (
                      <>
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
                            d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                        </svg>
                        Copy
                      </>
                    )}
                  </button>
                </div>
                <MarkdownBody>{currentSummary}</MarkdownBody>
              </>
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
                    {detail.summaries.map((sv) => {
                      // If no active version tracked, treat the highest version (first in DESC list) as active
                      const effectiveActive = activeSummaryVersion ?? detail.summaries[0]?.version ?? null;
                      const isActive = sv.version === effectiveActive;
                      return (
                        <div
                          key={sv.version}
                          className={`bg-gray-900 border rounded-lg p-3 ${isActive ? "border-indigo-600/50" : "border-gray-800"}`}
                        >
                          <div className="flex items-center justify-between mb-2">
                            <span className="text-xs text-gray-600">v{sv.version} · {formatDateLong(sv.created_at)}</span>
                            {isActive ? (
                              <span className="text-xs text-emerald-500">Current</span>
                            ) : (
                              <button
                                onClick={() => handleRestoreVersion(sv)}
                                disabled={summaryBusy}
                                className="text-xs text-indigo-400 hover:text-indigo-300 disabled:opacity-40"
                              >
                                Restore
                              </button>
                            )}
                          </div>
                          <p className="text-xs text-gray-500 line-clamp-3">{sv.content}</p>
                        </div>
                      );
                    })}
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
                <div
                  key={i}
                  className={`flex gap-3 text-sm py-0.5 rounded px-1 -mx-1 transition-colors cursor-pointer ${
                    activeSegmentIdx != null && sortedTranscript[activeSegmentIdx]?.start === entry.start
                      ? "bg-indigo-900/30"
                      : "hover:bg-gray-800/40"
                  }`}
                  onClick={() => { if (audioRef.current) { audioRef.current.currentTime = entry.start; audioRef.current.play(); } }}
                >
                  <span className="text-indigo-500/70 font-mono shrink-0 w-14 text-right text-xs pt-0.5">
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

        {/* ----- To-do ----- */}
        {tab === "todo" && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <p className="text-xs text-gray-500">
                {actionItems.length === 0
                  ? "No to-dos extracted yet."
                  : `${actionItems.filter((a) => !a.done).length} of ${actionItems.length} remaining`}
              </p>
              <button
                onClick={handleExtractActions}
                disabled={actionsBusy}
                className="btn-secondary text-xs disabled:opacity-40"
              >
                {actionsBusy ? <Spinner /> : actionItems.length > 0 ? "Re-extract" : "Extract from transcript"}
              </button>
            </div>

            {actionItems.length > 0 && (
              <ul className="space-y-1">
                {actionItems.map((item, idx) => (
                  <li
                    key={idx}
                    className="flex items-start gap-3 py-2 px-3 rounded-lg hover:bg-gray-800/50 group transition-colors"
                  >
                    <button
                      onClick={() => handleToggleAction(idx)}
                      className={`mt-0.5 w-4 h-4 rounded border shrink-0 flex items-center justify-center transition-colors ${
                        item.done
                          ? "bg-emerald-600 border-emerald-600 text-white"
                          : "border-gray-600 hover:border-gray-400"
                      }`}
                    >
                      {item.done && (
                        <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                    </button>
                    <span className={`flex-1 text-sm leading-snug ${item.done ? "line-through text-gray-600" : "text-gray-200"}`}>
                      {item.text}
                    </span>
                    <button
                      onClick={() => handleDeleteAction(idx)}
                      className="opacity-0 group-hover:opacity-100 text-gray-700 hover:text-red-400 text-xs transition-opacity shrink-0 mt-0.5"
                    >✕</button>
                  </li>
                ))}
              </ul>
            )}

            {actionItems.length === 0 && !actionsBusy && (
              <div className="text-center py-8">
                <div className="w-10 h-10 rounded-full bg-gray-800 flex items-center justify-center mx-auto mb-3">
                  <svg className="w-5 h-5 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                      d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
                  </svg>
                </div>
                <p className="text-sm text-gray-600">Click "Extract from transcript" to pull to-dos from the meeting.</p>
              </div>
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
