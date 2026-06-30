import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { MeetingListItem, NoteFile, AppView } from "../lib/types";

interface Props {
  onNavigate: (view: AppView) => void;
  onClose: () => void;
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso.replace(" ", "T") + "Z");
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  } catch { return ""; }
}

export default function SearchModal({ onNavigate, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [meetings, setMeetings] = useState<MeetingListItem[]>([]);
  const [notes, setNotes] = useState<NoteFile[]>([]);
  const [focused, setFocused] = useState<{ type: "meeting" | "note"; id: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  const search = useCallback(async (q: string) => {
    if (!q.trim()) { setMeetings([]); setNotes([]); setFocused(null); return; }
    try {
      const [m, n] = await Promise.all([
        invoke<MeetingListItem[]>("list_meetings", { search: q, folderId: null, sortBy: "date_desc" }),
        invoke<NoteFile[]>("list_notes", { search: q, folderId: null }),
      ]);
      setMeetings(m.slice(0, 6));
      setNotes(n.slice(0, 6));
      const first = m[0] ? { type: "meeting" as const, id: m[0].id } : n[0] ? { type: "note" as const, id: n[0].id } : null;
      setFocused(first);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => search(query), 200);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query, search]);

  const allResults: Array<{ type: "meeting" | "note"; id: string }> = [
    ...meetings.map((m) => ({ type: "meeting" as const, id: m.id })),
    ...notes.map((n) => ({ type: "note" as const, id: n.id })),
  ];

  function handleKeyDown(e: React.KeyboardEvent) {
    if (!allResults.length) return;
    const idx = focused ? allResults.findIndex((r) => r.type === focused.type && r.id === focused.id) : -1;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setFocused(allResults[(idx + 1) % allResults.length]);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setFocused(allResults[(idx - 1 + allResults.length) % allResults.length]);
    } else if (e.key === "Enter" && focused) {
      e.preventDefault();
      navigate(focused);
    }
  }

  function navigate(item: { type: "meeting" | "note"; id: string }) {
    if (item.type === "meeting") onNavigate({ kind: "meeting", id: item.id });
    else onNavigate({ kind: "note", id: item.id });
    onClose();
  }

  const hasResults = meetings.length > 0 || notes.length > 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh] bg-black/60 backdrop-blur-sm"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-xl bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl overflow-hidden">
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-800">
          <svg className="w-4 h-4 text-gray-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search meetings and notes…"
            className="flex-1 bg-transparent text-sm text-gray-100 placeholder-gray-600 focus:outline-none"
          />
          {query && (
            <button onClick={() => setQuery("")} className="text-gray-600 hover:text-gray-400 text-xs">
              Clear
            </button>
          )}
          <kbd className="text-[10px] text-gray-600 border border-gray-700 rounded px-1.5 py-0.5">Esc</kbd>
        </div>

        {/* Results */}
        <div className="max-h-[60vh] overflow-y-auto">
          {!query.trim() && (
            <p className="px-4 py-6 text-xs text-gray-600 text-center">Start typing to search…</p>
          )}

          {query.trim() && !hasResults && (
            <p className="px-4 py-6 text-xs text-gray-600 text-center">No results for "{query}"</p>
          )}

          {meetings.length > 0 && (
            <div>
              <p className="px-4 pt-3 pb-1 text-[10px] text-gray-600 uppercase tracking-widest font-medium">
                Meetings
              </p>
              {meetings.map((m) => {
                const isFocused = focused?.type === "meeting" && focused.id === m.id;
                return (
                  <button
                    key={m.id}
                    onMouseEnter={() => setFocused({ type: "meeting", id: m.id })}
                    onClick={() => navigate({ type: "meeting", id: m.id })}
                    className={`w-full text-left px-4 py-2.5 flex items-center gap-3 transition-colors ${
                      isFocused ? "bg-indigo-600/20" : "hover:bg-gray-800/60"
                    }`}
                  >
                    <svg className="w-3.5 h-3.5 text-gray-600 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
                        d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                    </svg>
                    <span className="flex-1 text-sm text-gray-200 truncate">{m.title}</span>
                    <span className="text-[10px] text-gray-600 shrink-0">{formatDate(m.created_at)}</span>
                  </button>
                );
              })}
            </div>
          )}

          {notes.length > 0 && (
            <div className={meetings.length > 0 ? "border-t border-gray-800/60" : ""}>
              <p className="px-4 pt-3 pb-1 text-[10px] text-gray-600 uppercase tracking-widest font-medium">
                Notes
              </p>
              {notes.map((n) => {
                const isFocused = focused?.type === "note" && focused.id === n.id;
                return (
                  <button
                    key={n.id}
                    onMouseEnter={() => setFocused({ type: "note", id: n.id })}
                    onClick={() => navigate({ type: "note", id: n.id })}
                    className={`w-full text-left px-4 py-2.5 flex items-center gap-3 transition-colors ${
                      isFocused ? "bg-indigo-600/20" : "hover:bg-gray-800/60"
                    }`}
                  >
                    <svg className="w-3.5 h-3.5 text-gray-600 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
                        d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                    </svg>
                    <span className="flex-1 text-sm text-gray-200 truncate">{n.title}</span>
                    <span className="text-[10px] text-gray-600 shrink-0">{formatDate(n.updated_at)}</span>
                  </button>
                );
              })}
            </div>
          )}

          {hasResults && (
            <p className="px-4 py-2 text-[10px] text-gray-700 text-center border-t border-gray-800/60">
              ↑↓ navigate · Enter select
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
