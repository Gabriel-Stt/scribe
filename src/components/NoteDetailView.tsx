import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { NoteFile, Folder } from "../lib/types";
import NoteEditor from "./NoteEditor";

function formatDate(iso: string): string {
  try {
    // SQLite returns "2026-06-30 14:23:45"; JS ISO already has "T" and "Z"
    const normalized = iso.includes("T") ? iso : iso.replace(" ", "T") + "Z";
    const d = new Date(normalized);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffDays = Math.floor(diffMs / 86400000);
    if (diffDays === 0) return `Today at ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
    if (diffDays === 1) return "Yesterday";
    if (diffDays < 7) return d.toLocaleDateString(undefined, { weekday: "long" });
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return iso.slice(0, 10);
  }
}

interface Props {
  noteId: string;
  onDeleted: () => void;
}

export default function NoteDetailView({ noteId, onDeleted }: Props) {
  const [note, setNote] = useState<NoteFile | null>(null);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [titleDraft, setTitleDraft] = useState("");
  const [showFolderPicker, setShowFolderPicker] = useState(false);
  const titleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const folderPickerRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const n = await invoke<NoteFile | null>("get_note", { noteId });
      if (n) { setNote(n); setTitleDraft(n.title); }
    } catch { /* ignore */ }
  }, [noteId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    invoke<Folder[]>("list_folders").then(setFolders).catch(() => {});
  }, []);

  useEffect(() => {
    if (!showFolderPicker) return;
    const handler = (e: MouseEvent) => {
      if (folderPickerRef.current && !folderPickerRef.current.contains(e.target as Node))
        setShowFolderPicker(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showFolderPicker]);

  async function saveTitle(id: string, title: string) {
    const trimmed = title.trim() || "Untitled Note";
    try {
      await invoke("save_note", { args: { note_id: id, title: trimmed, content: null } });
      setNote((prev) => prev ? { ...prev, title: trimmed } : prev);
      window.dispatchEvent(new Event("scribe:reload-notes"));
    } catch { /* ignore */ }
  }

  function handleTitleChange(val: string) {
    setTitleDraft(val);
    if (titleTimer.current) clearTimeout(titleTimer.current);
    if (note) titleTimer.current = setTimeout(() => saveTitle(note.id, val), 600);
  }

  async function handleMoveToFolder(folderId: string | null) {
    if (!note) return;
    try {
      await invoke("assign_note_folder", { noteId: note.id, folderId });
      setNote((prev) => prev ? { ...prev, folder_id: folderId } : prev);
      setShowFolderPicker(false);
      window.dispatchEvent(new Event("scribe:reload-notes"));
    } catch { /* ignore */ }
  }

  async function handleDelete() {
    if (!note) return;
    try {
      await invoke("delete_note", { noteId: note.id });
      window.dispatchEvent(new Event("scribe:reload-notes"));
      onDeleted();
    } catch { /* ignore */ }
  }

  if (!note) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-700 text-sm">
        Loading…
      </div>
    );
  }

  const activeFolder = folders.find((f) => f.id === note.folder_id);

  return (
    <div className="flex flex-col h-full">
      {/* Header bar */}
      <div className="px-6 pt-5 pb-3 shrink-0 border-b border-gray-800">
        <div className="flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <input
              value={titleDraft}
              onChange={(e) => handleTitleChange(e.target.value)}
              onBlur={() => saveTitle(note.id, titleDraft)}
              placeholder="Untitled Note"
              className="w-full bg-transparent text-xl font-semibold text-white placeholder-gray-700 focus:outline-none"
            />
            <div className="flex items-center gap-3 mt-1">
              <span className="text-[11px] text-gray-600">
                Edited {formatDate(note.updated_at)}
              </span>

              {/* Folder pill */}
              <div className="relative" ref={folderPickerRef}>
                <button
                  onClick={() => setShowFolderPicker((v) => !v)}
                  className="flex items-center gap-1.5 text-[11px] rounded-full px-2 py-0.5 transition-colors hover:bg-gray-800"
                  style={activeFolder
                    ? { background: activeFolder.color + "22", color: activeFolder.color }
                    : { color: "#4b5563" }}
                >
                  {activeFolder ? (
                    <>
                      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: activeFolder.color }} />
                      {activeFolder.name}
                    </>
                  ) : (
                    <>
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                          d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
                      </svg>
                      Add to folder
                    </>
                  )}
                </button>

                {showFolderPicker && (
                  <div className="absolute top-full left-0 mt-1 z-20 bg-gray-800 border border-gray-700 rounded-lg shadow-xl py-1 min-w-[160px]">
                    {note.folder_id && (
                      <button
                        onClick={() => handleMoveToFolder(null)}
                        className="w-full text-left px-3 py-1.5 text-xs text-gray-400 hover:bg-gray-700"
                      >
                        Remove from folder
                      </button>
                    )}
                    {folders.map((f) => (
                      <button
                        key={f.id}
                        onClick={() => handleMoveToFolder(f.id)}
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
            </div>
          </div>

          {/* Delete */}
          <button
            onClick={handleDelete}
            title="Delete note"
            className="p-1.5 rounded-lg text-gray-600 hover:text-red-400 hover:bg-gray-800 transition-colors shrink-0 mt-1"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
                d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </button>
        </div>
      </div>

      {/* Editor */}
      <div className="flex-1 overflow-hidden">
        <NoteEditor
          key={note.id}
          initialContent={note.content}
          onSave={async (html) => {
            await invoke("save_note", { args: { note_id: note.id, title: null, content: html } });
            setNote((prev) => prev ? { ...prev, content: html, updated_at: new Date().toISOString() } : prev);
            window.dispatchEvent(new Event("scribe:reload-notes"));
          }}
        />
      </div>
    </div>
  );
}
