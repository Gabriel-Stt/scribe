import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AppView, SplitPanel, MeetingListItem, NoteFile } from "../lib/types";

// ── Trigger button ────────────────────────────────────────────────────────────

interface Props {
  currentPanel: SplitPanel;
  onNavigate: (view: AppView) => void;
}

export default function SplitButton({ currentPanel, onNavigate }: Props) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="Open in split view"
        className="absolute top-3 right-3 z-20 p-1.5 rounded-lg border bg-gray-900/90 backdrop-blur border-gray-700 text-gray-400 hover:text-white hover:bg-gray-700 transition-all opacity-0 group-hover:opacity-100"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
            d="M9 3H5a2 2 0 00-2 2v14a2 2 0 002 2h4M15 3h4a2 2 0 012 2v14a2 2 0 01-2 2h-4M9 3v18M15 3v18" />
        </svg>
      </button>

      {open && (
        <SplitPickerModal
          currentPanel={currentPanel}
          onNavigate={onNavigate}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

// ── Collapse button (shown on split panels) ───────────────────────────────────

export function CollapseButton({
  panel,
  onNavigate,
}: { panel: SplitPanel; onNavigate: (view: AppView) => void }) {
  return (
    <button
      onClick={() => onNavigate(panelToSingleView(panel))}
      title="Expand to full view"
      className="absolute top-3 right-3 z-20 p-1.5 rounded-lg border bg-gray-900/90 backdrop-blur border-gray-700 text-gray-400 hover:text-white hover:bg-gray-700 transition-all opacity-0 group-hover:opacity-100"
    >
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
          d="M4 8V4m0 0h4M4 4l5 5m11-5h-4m4 0v4m0-4l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
      </svg>
    </button>
  );
}

function panelToSingleView(panel: SplitPanel): AppView {
  switch (panel.kind) {
    case "record":  return { kind: "record" };
    case "meeting": return { kind: "meeting", id: panel.id };
    case "note":    return { kind: "note", id: panel.id };
    case "chat":    return { kind: "chat", sessionId: panel.sessionId };
  }
}

// ── Picker modal ──────────────────────────────────────────────────────────────

interface ModalProps {
  currentPanel: SplitPanel;
  onNavigate: (view: AppView) => void;
  onClose: () => void;
}

function SplitPickerModal({ currentPanel, onNavigate, onClose }: ModalProps) {
  const [side, setSide] = useState<"left" | "right">("left");
  const [meetings, setMeetings] = useState<MeetingListItem[]>([]);
  const [notes, setNotes] = useState<NoteFile[]>([]);
  const [meetingQ, setMeetingQ] = useState("");
  const [noteQ, setNoteQ] = useState("");

  useEffect(() => {
    invoke<MeetingListItem[]>("list_meetings", { search: null, folderId: null, sortBy: "date_desc" })
      .then(setMeetings).catch(() => {});
    invoke<NoteFile[]>("list_notes", { search: null, folderId: null })
      .then(setNotes).catch(() => {});
  }, []);

  // Close on Escape
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  async function pick(other: SplitPanel) {
    const left  = side === "left"  ? currentPanel : other;
    const right = side === "right" ? currentPanel : other;
    onNavigate({ kind: "split", left, right });
    onClose();
  }

  async function pickNewNote() {
    try {
      const note = await invoke<NoteFile>("create_note");
      const title = `Notes — ${new Date().toLocaleDateString(undefined, {
        month: "short", day: "numeric", year: "numeric",
      })}`;
      await invoke("save_note", { args: { note_id: note.id, title, content: null } });
      window.dispatchEvent(new Event("scribe:reload-notes"));
      await pick({ kind: "note", id: note.id });
    } catch { /* ignore */ }
  }

  const filteredMeetings = meetings.filter((m) =>
    m.title.toLowerCase().includes(meetingQ.toLowerCase()),
  );
  const filteredNotes = notes.filter((n) =>
    n.title.toLowerCase().includes(noteQ.toLowerCase()),
  );

  const currentLabel = panelLabel(currentPanel);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl w-[460px] max-h-[78vh] flex flex-col overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800 shrink-0">
          <div>
            <p className="text-sm font-semibold text-white">Split view</p>
            <p className="text-xs text-gray-500 mt-0.5">Current: {currentLabel}</p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-600 hover:text-gray-300 transition-colors p-1"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Side toggle */}
        <div className="px-5 py-3 border-b border-gray-800 shrink-0">
          <p className="text-[10px] text-gray-500 uppercase tracking-widest mb-2">Place current view on</p>
          <div className="flex gap-2">
            <button
              onClick={() => setSide("left")}
              className={`flex-1 py-2 rounded-lg text-xs font-medium border transition-colors flex items-center justify-center gap-1.5 ${
                side === "left"
                  ? "bg-indigo-600 border-indigo-500 text-white"
                  : "border-gray-700 text-gray-400 hover:border-gray-600 hover:text-gray-300"
              }`}
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
              Left side
            </button>
            <button
              onClick={() => setSide("right")}
              className={`flex-1 py-2 rounded-lg text-xs font-medium border transition-colors flex items-center justify-center gap-1.5 ${
                side === "right"
                  ? "bg-indigo-600 border-indigo-500 text-white"
                  : "border-gray-700 text-gray-400 hover:border-gray-600 hover:text-gray-300"
              }`}
            >
              Right side
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </button>
          </div>
        </div>

        {/* Scrollable options */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">

          {/* Quick picks */}
          <div className="grid grid-cols-2 gap-2">
            {currentPanel.kind !== "record" && (
              <QuickTile
                icon={<span className="w-3 h-3 rounded-full bg-red-400 inline-block" />}
                label="Recording"
                onClick={() => pick({ kind: "record" })}
              />
            )}
            {currentPanel.kind !== "chat" && (
              <QuickTile
                icon={
                  <svg className="w-4 h-4 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
                      d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                  </svg>
                }
                label="New Chat"
                onClick={() => pick({ kind: "chat", sessionId: null })}
              />
            )}
          </div>

          {/* Notes */}
          {currentPanel.kind !== "note" && (
            <Section label="Notes">
              <button
                onClick={pickNewNote}
                className="w-full text-left px-3 py-2 rounded-lg border border-dashed border-gray-700 text-xs text-gray-400 hover:border-indigo-600 hover:text-indigo-400 transition-colors mb-2 flex items-center gap-2"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
                New blank note
              </button>
              {notes.length > 4 && (
                <SearchBox value={noteQ} onChange={setNoteQ} placeholder="Search notes…" />
              )}
              <div className="space-y-0.5 max-h-44 overflow-y-auto">
                {filteredNotes.length === 0 && noteQ && (
                  <p className="text-xs text-gray-600 py-2 text-center">No notes match</p>
                )}
                {filteredNotes.map((n) => (
                  <ListRow key={n.id} label={n.title || "Untitled Note"} onClick={() => pick({ kind: "note", id: n.id })} />
                ))}
              </div>
            </Section>
          )}

          {/* Meetings */}
          {currentPanel.kind !== "meeting" && (
            <Section label="Meetings">
              {meetings.length > 4 && (
                <SearchBox value={meetingQ} onChange={setMeetingQ} placeholder="Search meetings…" />
              )}
              <div className="space-y-0.5 max-h-44 overflow-y-auto">
                {filteredMeetings.length === 0 && (
                  <p className="text-xs text-gray-600 py-2 text-center">
                    {meetingQ ? "No meetings match" : "No meetings yet"}
                  </p>
                )}
                {filteredMeetings.map((m) => (
                  <ListRow key={m.id} label={m.title} onClick={() => pick({ kind: "meeting", id: m.id })} />
                ))}
              </div>
            </Section>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function panelLabel(panel: SplitPanel): string {
  switch (panel.kind) {
    case "record":  return "Recording";
    case "meeting": return "Meeting";
    case "note":    return "Note";
    case "chat":    return "Chat";
  }
}

function QuickTile({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-2.5 px-4 py-3 rounded-xl border border-gray-700 text-sm text-gray-200 hover:border-gray-500 hover:bg-gray-800 transition-colors"
    >
      {icon}
      {label}
    </button>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[10px] text-gray-500 uppercase tracking-widest mb-2">{label}</p>
      {children}
    </div>
  );
}

function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return (
    <input
      ref={ref}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:border-indigo-600 mb-2"
    />
  );
}

function ListRow({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="w-full text-left px-3 py-2 rounded-lg text-xs text-gray-300 hover:bg-gray-800 hover:text-white transition-colors truncate block"
    >
      {label}
    </button>
  );
}
