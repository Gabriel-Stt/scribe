import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { NoteFile } from "../lib/types";
import NoteEditor from "./NoteEditor";

function htmlToSnippet(html: string, maxLen = 80): string {
  const plain = html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > maxLen ? plain.slice(0, maxLen) + "…" : plain;
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso.replace(" ", "T") + "Z");
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffDays = Math.floor(diffMs / 86400000);
    if (diffDays === 0) return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    if (diffDays === 1) return "Yesterday";
    if (diffDays < 7) return d.toLocaleDateString(undefined, { weekday: "short" });
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return iso.slice(0, 10);
  }
}

export default function NotesView() {
  const [notes, setNotes] = useState<NoteFile[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [titleDraft, setTitleDraft] = useState("");
  const titleSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadNotes = useCallback(async () => {
    try {
      const list = await invoke<NoteFile[]>("list_notes");
      setNotes(list);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { loadNotes(); }, [loadNotes]);

  const selectedNote = notes.find((n) => n.id === selectedId) ?? null;

  useEffect(() => {
    if (selectedNote) setTitleDraft(selectedNote.title);
  }, [selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleCreate() {
    try {
      const note = await invoke<NoteFile>("create_note");
      setNotes((prev) => [note, ...prev]);
      setSelectedId(note.id);
    } catch { /* ignore */ }
  }

  async function handleDelete(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    try {
      await invoke("delete_note", { noteId: id });
      setNotes((prev) => prev.filter((n) => n.id !== id));
      if (selectedId === id) setSelectedId(null);
    } catch { /* ignore */ }
  }

  async function saveTitle(id: string, title: string) {
    const trimmed = title.trim() || "Untitled Note";
    try {
      await invoke("save_note", { args: { note_id: id, title: trimmed, content: null } });
      setNotes((prev) =>
        prev.map((n) => n.id === id ? { ...n, title: trimmed, updated_at: new Date().toISOString() } : n)
      );
    } catch { /* ignore */ }
  }

  function handleTitleChange(val: string) {
    setTitleDraft(val);
    if (titleSaveTimer.current) clearTimeout(titleSaveTimer.current);
    if (selectedId) {
      titleSaveTimer.current = setTimeout(() => saveTitle(selectedId, val), 600);
    }
  }

  const filtered = notes.filter((n) =>
    search.trim() === "" ||
    n.title.toLowerCase().includes(search.toLowerCase()) ||
    htmlToSnippet(n.content, 500).toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="flex h-full">
      {/* Left pane — notes list */}
      <div className="w-56 shrink-0 border-r border-gray-800 flex flex-col bg-gray-900/40">
        <div className="px-3 pt-4 pb-2 shrink-0">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-gray-400 uppercase tracking-widest">Notes</span>
            <button
              onClick={handleCreate}
              className="text-indigo-400 hover:text-indigo-300 transition-colors"
              title="New note"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
            </button>
          </div>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search notes…"
            className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          />
        </div>

        <div className="flex-1 overflow-y-auto min-h-0">
          {filtered.length === 0 && (
            <p className="px-3 py-6 text-xs text-gray-600 text-center">
              {notes.length === 0 ? "No notes yet" : "No matches"}
            </p>
          )}
          {filtered.map((note) => (
            <div
              key={note.id}
              className={`group relative cursor-pointer border-b border-gray-800/60 px-3 py-2.5 transition-colors ${
                selectedId === note.id ? "bg-gray-800" : "hover:bg-gray-800/50"
              }`}
              onClick={() => setSelectedId(note.id)}
              style={selectedId === note.id ? { borderLeft: "2px solid #6366f1" } : {}}
            >
              <p className="text-xs font-medium text-gray-200 leading-tight line-clamp-1 pr-5">
                {note.title}
              </p>
              <p className="text-[10px] text-gray-600 mt-0.5">{formatDate(note.updated_at)}</p>
              {note.content && (
                <p className="text-[10px] text-gray-600 mt-0.5 line-clamp-2 leading-tight">
                  {htmlToSnippet(note.content)}
                </p>
              )}
              <button
                onClick={(e) => handleDelete(note.id, e)}
                className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 text-gray-700 hover:text-red-400 transition-opacity text-xs"
                title="Delete note"
              >✕</button>
            </div>
          ))}
        </div>

        {notes.length === 0 && (
          <div className="shrink-0 px-3 pb-4">
            <button
              onClick={handleCreate}
              className="w-full py-2 text-xs text-indigo-400 hover:text-indigo-300 border border-dashed border-indigo-800 rounded-lg hover:border-indigo-600 transition-colors"
            >
              + New Note
            </button>
          </div>
        )}
      </div>

      {/* Right pane — editor */}
      {selectedNote ? (
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
          {/* Title bar */}
          <div className="px-6 pt-5 pb-0 shrink-0">
            <input
              value={titleDraft}
              onChange={(e) => handleTitleChange(e.target.value)}
              onBlur={() => selectedId && saveTitle(selectedId, titleDraft)}
              placeholder="Untitled Note"
              className="w-full bg-transparent text-lg font-semibold text-white placeholder-gray-700 focus:outline-none border-b border-transparent focus:border-gray-700 pb-1 transition-colors"
            />
            <p className="text-[10px] text-gray-600 mt-1 mb-2">
              Last edited {formatDate(selectedNote.updated_at)}
            </p>
          </div>

          {/* Rich text editor */}
          <div className="flex-1 overflow-hidden border-t border-gray-800">
            <NoteEditor
              key={selectedNote.id}
              initialContent={selectedNote.content}
              onSave={async (html) => {
                await invoke("save_note", { args: { note_id: selectedNote.id, title: null, content: html } });
                setNotes((prev) =>
                  prev.map((n) =>
                    n.id === selectedNote.id
                      ? { ...n, content: html, updated_at: new Date().toISOString() }
                      : n
                  )
                );
              }}
            />
          </div>
        </div>
      ) : (
        <div className="flex-1 flex flex-col items-center justify-center text-center gap-4 p-8">
          <div className="w-12 h-12 rounded-full bg-gray-800 flex items-center justify-center">
            <svg className="w-5 h-5 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
            </svg>
          </div>
          <div>
            <p className="text-sm text-gray-500">
              {notes.length === 0 ? "Create your first note" : "Select a note to edit"}
            </p>
          </div>
          <button onClick={handleCreate} className="btn-secondary text-sm">
            New Note
          </button>
        </div>
      )}
    </div>
  );
}
