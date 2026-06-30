import { useEffect, useState, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { MeetingListItem, NoteFile, Folder, AppView, AppSettings, UserTag } from "../lib/types";
import { formatTime } from "./shared";

interface SidebarProps {
  view: AppView;
  onNavigate: (view: AppView) => void;
}

interface MeetingContextMenuState {
  x: number;
  y: number;
  meeting: MeetingListItem;
}

interface NoteContextMenuState {
  x: number;
  y: number;
  note: NoteFile;
}

const FOLDER_COLORS = [
  "#6366f1", "#8b5cf6", "#ec4899", "#ef4444",
  "#f97316", "#eab308", "#22c55e", "#14b8a6",
  "#3b82f6", "#06b6d4",
];

const TAG_COLORS = [
  "#ef4444", "#f97316", "#eab308", "#22c55e",
  "#14b8a6", "#3b82f6", "#8b5cf6", "#ec4899",
  "#06b6d4", "#6b7280",
];

export default function Sidebar({ view, onNavigate }: SidebarProps) {
  const [sidebarMode, setSidebarMode] = useState<"meetings" | "notes">("meetings");

  // ── Meetings state ─────────────────────────────────────────────────────────
  const [meetings, setMeetings] = useState<MeetingListItem[]>([]);
  const [sortBy, setSortBy] = useState("date_desc");
  const sortByRef = useRef("date_desc");
  const [draggingMeetingId, setDraggingMeetingId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<MeetingContextMenuState | null>(null);
  const [contextMenuTagIds, setContextMenuTagIds] = useState<string[]>([]);
  const [showCreateTagInMenu, setShowCreateTagInMenu] = useState(false);
  const [menuTagName, setMenuTagName] = useState("");
  const [menuTagColor, setMenuTagColor] = useState(TAG_COLORS[0]);
  const [renamingMeeting, setRenamingMeeting] = useState<string | null>(null);
  const [renameMeetingDraft, setRenameMeetingDraft] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<MeetingListItem | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  // ── Notes state ────────────────────────────────────────────────────────────
  const [notes, setNotes] = useState<NoteFile[]>([]);
  const [draggingNoteId, setDraggingNoteId] = useState<string | null>(null);
  const [noteContextMenu, setNoteContextMenu] = useState<NoteContextMenuState | null>(null);
  const [renamingNote, setRenamingNote] = useState<string | null>(null);
  const [renameNoteDraft, setRenameNoteDraft] = useState("");
  const noteContextMenuRef = useRef<HTMLDivElement>(null);

  // ── Shared state ───────────────────────────────────────────────────────────
  const [search, setSearch] = useState("");
  const [folders, setFolders] = useState<Folder[]>([]);
  const [allTags, setAllTags] = useState<UserTag[]>([]);
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [dragOverTarget, setDragOverTarget] = useState<string | "all" | null>(null);
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [newFolderColor, setNewFolderColor] = useState(FOLDER_COLORS[0]);
  const [renamingFolder, setRenamingFolder] = useState<string | null>(null);
  const [renameFolderDraft, setRenameFolderDraft] = useState("");
  const newFolderInputRef = useRef<HTMLInputElement>(null);

  // ── Load helpers ───────────────────────────────────────────────────────────
  const loadMeetings = useCallback(async (q?: string, fid?: string | null) => {
    try {
      const items = await invoke<MeetingListItem[]>("list_meetings", {
        search: q || null,
        folderId: fid !== undefined ? fid : selectedFolderId,
        sortBy: sortByRef.current,
      });
      setMeetings(items);
    } catch { /* ignore */ }
  }, [selectedFolderId]);

  const loadNotes = useCallback(async (q?: string, fid?: string | null) => {
    try {
      const items = await invoke<NoteFile[]>("list_notes", {
        search: q || null,
        folderId: fid !== undefined ? fid : selectedFolderId,
      });
      setNotes(items);
    } catch { /* ignore */ }
  }, [selectedFolderId]);

  const loadFolders = useCallback(async () => {
    try { setFolders(await invoke<Folder[]>("list_folders")); } catch { /* ignore */ }
  }, []);

  const loadAllTags = useCallback(async () => {
    try { setAllTags(await invoke<UserTag[]>("list_tags")); } catch { /* ignore */ }
  }, []);

  // ── Initial loads ──────────────────────────────────────────────────────────
  useEffect(() => {
    invoke<AppSettings>("get_app_settings")
      .then((s) => { const v = s.sort_by ?? "date_desc"; setSortBy(v); sortByRef.current = v; })
      .catch(() => {});
  }, []);

  useEffect(() => { loadFolders(); }, [loadFolders]);
  useEffect(() => { loadAllTags(); }, [loadAllTags]);
  useEffect(() => { loadMeetings(search || undefined, selectedFolderId); }, [search, selectedFolderId, sortBy, loadMeetings]);
  useEffect(() => {
    if (sidebarMode === "notes") loadNotes(search || undefined, selectedFolderId);
  }, [search, selectedFolderId, sidebarMode, loadNotes]);

  // ── Event listeners ────────────────────────────────────────────────────────
  useEffect(() => {
    const unsubs = [listen("meeting-title-ready", () => loadMeetings(search || undefined))];
    return () => { unsubs.forEach((p) => p.then((u) => u())); };
  }, [loadMeetings, search]);

  useEffect(() => {
    const h = () => loadMeetings(search || undefined);
    window.addEventListener("scribe:reload-meetings", h);
    return () => window.removeEventListener("scribe:reload-meetings", h);
  }, [loadMeetings, search]);

  useEffect(() => {
    const h = () => loadNotes(search || undefined);
    window.addEventListener("scribe:reload-notes", h);
    return () => window.removeEventListener("scribe:reload-notes", h);
  }, [loadNotes, search]);

  // ── Context menu outside-click handlers ────────────────────────────────────
  useEffect(() => {
    if (!contextMenu) return;
    const h = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) setContextMenu(null);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [contextMenu]);

  useEffect(() => {
    if (!noteContextMenu) return;
    const h = (e: MouseEvent) => {
      if (noteContextMenuRef.current && !noteContextMenuRef.current.contains(e.target as Node)) setNoteContextMenu(null);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [noteContextMenu]);

  useEffect(() => {
    if (contextMenu) {
      setContextMenuTagIds(contextMenu.meeting.tags.map((t) => t.id));
      setShowCreateTagInMenu(false);
      setMenuTagName("");
      setMenuTagColor(TAG_COLORS[0]);
    }
  }, [contextMenu]);

  useEffect(() => {
    if (showNewFolder) newFolderInputRef.current?.focus();
  }, [showNewFolder]);

  // ── Derived ────────────────────────────────────────────────────────────────
  const activeId      = view.kind === "meeting" ? view.id : null;
  const activeNoteId  = view.kind === "note"    ? view.id : null;
  const folderById    = (id: string | null) => folders.find((f) => f.id === id);

  // ── Meeting actions ────────────────────────────────────────────────────────
  async function handleSortChange(val: string) {
    setSortBy(val);
    sortByRef.current = val;
    try {
      const s = await invoke<AppSettings>("get_app_settings");
      await invoke("save_app_settings", { settings: { ...s, sort_by: val } });
    } catch { /* ignore */ }
  }

  async function handleMoveToFolder(meetingId: string, folderId: string | null) {
    await invoke("assign_meeting_folder", { meetingId, folderId });
    setContextMenu(null);
    loadMeetings(search || undefined);
    window.dispatchEvent(new Event("scribe:reload-meetings"));
  }

  async function handleRenameMeeting(id: string) {
    if (!renameMeetingDraft.trim()) { setRenamingMeeting(null); return; }
    await invoke("update_meeting", { args: { id, title: renameMeetingDraft.trim() } });
    setRenamingMeeting(null);
    loadMeetings(search || undefined);
    window.dispatchEvent(new Event("scribe:reload-meetings"));
  }

  async function confirmDeleteMeeting(id: string) {
    setConfirmDelete(null);
    await invoke("delete_meeting", { meetingId: id });
    if (view.kind === "meeting" && view.id === id) onNavigate({ kind: "home" });
    loadMeetings(search || undefined);
    window.dispatchEvent(new Event("scribe:reload-meetings"));
  }

  async function handleTogglePin(meeting: MeetingListItem) {
    await invoke("toggle_pin_meeting", { meetingId: meeting.id, pinned: !meeting.is_pinned });
    setContextMenu(null);
    loadMeetings(search || undefined);
  }

  async function handleToggleMeetingTag(tagId: string) {
    const newIds = contextMenuTagIds.includes(tagId)
      ? contextMenuTagIds.filter((id) => id !== tagId)
      : [...contextMenuTagIds, tagId];
    setContextMenuTagIds(newIds);
    await invoke("set_meeting_tags", { meetingId: contextMenu!.meeting.id, tagIds: newIds });
    loadMeetings(search || undefined);
  }

  async function handleCreateTagFromMenu() {
    if (!menuTagName.trim() || !contextMenu) return;
    try {
      const tag = await invoke<UserTag>("create_tag", { args: { name: menuTagName.trim(), color: menuTagColor } });
      const newIds = [...contextMenuTagIds, tag.id];
      setContextMenuTagIds(newIds);
      await invoke("set_meeting_tags", { meetingId: contextMenu.meeting.id, tagIds: newIds });
      setMenuTagName("");
      setShowCreateTagInMenu(false);
      loadAllTags();
      loadMeetings(search || undefined);
    } catch { /* ignore */ }
  }

  // ── Note actions ───────────────────────────────────────────────────────────
  async function handleCreateNote() {
    try {
      const note = await invoke<NoteFile>("create_note");
      if (selectedFolderId) {
        await invoke("assign_note_folder", { noteId: note.id, folderId: selectedFolderId });
      }
      setNotes((prev) => [{ ...note, folder_id: selectedFolderId }, ...prev]);
      onNavigate({ kind: "note", id: note.id });
    } catch { /* ignore */ }
  }

  async function handleMoveNoteToFolder(noteId: string, folderId: string | null) {
    await invoke("assign_note_folder", { noteId, folderId });
    setNoteContextMenu(null);
    loadNotes(search || undefined);
  }

  async function handleRenameNote(id: string) {
    if (!renameNoteDraft.trim()) { setRenamingNote(null); return; }
    await invoke("save_note", { args: { note_id: id, title: renameNoteDraft.trim(), content: null } });
    setRenamingNote(null);
    loadNotes(search || undefined);
  }

  async function handleDeleteNote(noteId: string) {
    setNoteContextMenu(null);
    await invoke("delete_note", { noteId });
    if (view.kind === "note" && view.id === noteId) onNavigate({ kind: "home" });
    loadNotes(search || undefined);
  }

  // ── Folder actions ─────────────────────────────────────────────────────────
  async function handleCreateFolder() {
    if (!newFolderName.trim()) return;
    await invoke("create_folder", { args: { name: newFolderName.trim(), color: newFolderColor } });
    setNewFolderName("");
    setNewFolderColor(FOLDER_COLORS[0]);
    setShowNewFolder(false);
    loadFolders();
  }

  async function handleDeleteFolder(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    await invoke("delete_folder", { folderId: id });
    if (selectedFolderId === id) setSelectedFolderId(null);
    loadFolders();
    loadMeetings(search || undefined, null);
    loadNotes(search || undefined, null);
  }

  async function handleRenameFolder(id: string) {
    if (!renameFolderDraft.trim()) { setRenamingFolder(null); return; }
    await invoke("rename_folder", { args: { id, name: renameFolderDraft.trim() } });
    setRenamingFolder(null);
    loadFolders();
  }

  // ── Drag and drop ──────────────────────────────────────────────────────────
  function handleDragStart(e: React.DragEvent, meetingId: string) {
    setDraggingMeetingId(meetingId);
    e.dataTransfer.setData("meetingId", meetingId);
    e.dataTransfer.effectAllowed = "move";
  }
  function handleDragEnd() { setDraggingMeetingId(null); setDragOverTarget(null); }

  function handleNoteDragStart(e: React.DragEvent, noteId: string) {
    setDraggingNoteId(noteId);
    e.dataTransfer.setData("noteId", noteId);
    e.dataTransfer.effectAllowed = "move";
  }
  function handleNoteDragEnd() { setDraggingNoteId(null); setDragOverTarget(null); }

  function handleFolderDragOver(e: React.DragEvent, target: string | "all") {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverTarget(target);
  }
  function handleFolderDragLeave(e: React.DragEvent) {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOverTarget(null);
  }
  function handleFolderDrop(e: React.DragEvent, folderId: string | null) {
    e.preventDefault();
    const meetingId = e.dataTransfer.getData("meetingId");
    const noteId    = e.dataTransfer.getData("noteId");
    if (meetingId) handleMoveToFolder(meetingId, folderId);
    if (noteId)    handleMoveNoteToFolder(noteId, folderId);
    setDragOverTarget(null);
    setDraggingMeetingId(null);
    setDraggingNoteId(null);
  }

  return (
    <aside className="w-60 shrink-0 flex flex-col bg-gray-900 border-r border-gray-800 h-full select-none">
      {/* Header */}
      <div className="px-4 pt-5 pb-3 flex items-center justify-between shrink-0">
        <span className="text-sm font-semibold text-white tracking-tight">Scribe</span>
        <button
          onClick={() => onNavigate({ kind: "settings" })}
          title="Settings"
          className={`p-1.5 rounded-lg transition-colors ${
            view.kind === "settings" ? "bg-gray-700 text-white" : "text-gray-500 hover:text-gray-300 hover:bg-gray-800"
          }`}
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
              d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        </button>
      </div>

      {/* New Recording button */}
      <div className="px-3 pb-2 shrink-0">
        <button
          onClick={() => onNavigate({ kind: "record" })}
          className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
            view.kind === "record" ? "bg-indigo-600 text-white" : "bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-300"
          }`}
        >
          <span className="text-base leading-none">●</span>
          New Recording
        </button>
      </div>

      {/* Meetings / Notes toggle */}
      <div className="px-3 pb-2 shrink-0">
        <div className="flex rounded-lg bg-gray-800/70 p-0.5 gap-0.5">
          <button
            onClick={() => setSidebarMode("meetings")}
            className={`flex-1 text-[11px] py-1 rounded-md font-medium transition-colors ${
              sidebarMode === "meetings" ? "bg-gray-700 text-gray-200 shadow-sm" : "text-gray-500 hover:text-gray-400"
            }`}
          >
            Meetings
          </button>
          <button
            onClick={() => { setSidebarMode("notes"); loadNotes(search || undefined, selectedFolderId); }}
            className={`flex-1 text-[11px] py-1 rounded-md font-medium transition-colors ${
              sidebarMode === "notes" ? "bg-gray-700 text-gray-200 shadow-sm" : "text-gray-500 hover:text-gray-400"
            }`}
          >
            Notes
          </button>
        </div>
      </div>

      {/* Search */}
      <div className="px-3 pb-2 shrink-0">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={sidebarMode === "notes" ? "Search notes…" : "Search meetings…"}
          className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-indigo-500"
        />
      </div>

      {/* Folder navigation — shared between modes */}
      <div className="px-2 pb-2 shrink-0">
        <div
          onClick={() => setSelectedFolderId(null)}
          onDragOver={(e) => handleFolderDragOver(e, "all")}
          onDragLeave={handleFolderDragLeave}
          onDrop={(e) => handleFolderDrop(e, null)}
          className={`flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer transition-colors text-xs font-medium ${
            selectedFolderId === null ? "bg-gray-800 text-gray-200" : "text-gray-500 hover:text-gray-300 hover:bg-gray-800/50"
          } ${dragOverTarget === "all" ? "ring-1 ring-indigo-400 bg-indigo-900/30" : ""}`}
        >
          <svg className="w-3.5 h-3.5 shrink-0 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h16M4 18h16" />
          </svg>
          <span className="truncate">{sidebarMode === "notes" ? "All Notes" : "All Meetings"}</span>
        </div>

        <div className="mt-0.5 space-y-0.5 max-h-44 overflow-y-auto">
          {folders.map((f) => (
            <div
              key={f.id}
              onDragOver={(e) => handleFolderDragOver(e, f.id)}
              onDragLeave={handleFolderDragLeave}
              onDrop={(e) => handleFolderDrop(e, f.id)}
              className="group flex items-center gap-1 rounded-lg transition-colors"
              style={dragOverTarget === f.id ? { boxShadow: `0 0 0 1px ${f.color}`, backgroundColor: f.color + "22" } : {}}
            >
              {renamingFolder === f.id ? (
                <input
                  autoFocus
                  value={renameFolderDraft}
                  onChange={(e) => setRenameFolderDraft(e.target.value)}
                  onBlur={() => handleRenameFolder(f.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleRenameFolder(f.id);
                    if (e.key === "Escape") setRenamingFolder(null);
                  }}
                  className="flex-1 bg-gray-800 border border-indigo-500 rounded px-1.5 py-0.5 text-xs text-white focus:outline-none mx-1 my-0.5"
                />
              ) : (
                <button
                  onClick={() => setSelectedFolderId(selectedFolderId === f.id ? null : f.id)}
                  onDoubleClick={() => { setRenamingFolder(f.id); setRenameFolderDraft(f.name); }}
                  className={`flex-1 flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs text-left transition-colors ${
                    selectedFolderId === f.id ? "bg-gray-800 text-gray-200" : "text-gray-500 hover:text-gray-300 hover:bg-gray-800/50"
                  }`}
                >
                  <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: f.color }} />
                  <span className="truncate flex-1">{f.name}</span>
                </button>
              )}
              <button
                onClick={(e) => handleDeleteFolder(f.id, e)}
                className="opacity-0 group-hover:opacity-100 text-gray-700 hover:text-red-400 text-xs pr-1.5 transition-opacity shrink-0"
                title="Delete folder"
              >✕</button>
            </div>
          ))}
        </div>

        {showNewFolder ? (
          <div className="mt-1.5 space-y-1.5 px-1">
            <input
              ref={newFolderInputRef}
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleCreateFolder(); if (e.key === "Escape") setShowNewFolder(false); }}
              placeholder="Folder name…"
              className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
            <div className="flex gap-1 flex-wrap">
              {FOLDER_COLORS.map((c) => (
                <button key={c} onClick={() => setNewFolderColor(c)}
                  className={`w-4 h-4 rounded-full transition-transform ${newFolderColor === c ? "ring-2 ring-white scale-110" : ""}`}
                  style={{ background: c }} />
              ))}
            </div>
            <div className="flex gap-1">
              <button onClick={handleCreateFolder} className="flex-1 text-xs py-1 bg-indigo-600 hover:bg-indigo-700 text-white rounded">Create</button>
              <button onClick={() => setShowNewFolder(false)} className="text-xs py-1 px-2 text-gray-500 hover:text-gray-300">Cancel</button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setShowNewFolder(true)}
            className="mt-1 flex items-center gap-1.5 px-2 py-1 w-full text-xs text-gray-600 hover:text-gray-400 transition-colors rounded-lg hover:bg-gray-800/50"
          >
            <span className="text-sm leading-none">+</span>
            <span>New Folder</span>
          </button>
        )}
      </div>

      <div className="border-t border-gray-800 mx-3 mb-1 shrink-0" />

      {/* Sort controls (meetings) / New Note button (notes) */}
      {sidebarMode === "meetings" ? (
        <>
          <div className="px-3 pb-1 shrink-0 flex items-center gap-1.5">
            <span className="text-[10px] text-gray-600 uppercase tracking-widest">Sort</span>
            <select
              value={sortBy}
              onChange={(e) => handleSortChange(e.target.value)}
              className="flex-1 bg-transparent text-[10px] text-gray-500 focus:outline-none cursor-pointer"
            >
              <option value="date_desc">Newest first</option>
              <option value="date_asc">Oldest first</option>
              <option value="title_asc">A → Z</option>
              <option value="title_desc">Z → A</option>
              <option value="duration_desc">Longest</option>
              <option value="duration_asc">Shortest</option>
            </select>
          </div>
          {selectedFolderId && (
            <div className="px-3 pb-1 flex items-center gap-1.5 shrink-0">
              <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: folderById(selectedFolderId)?.color ?? "#6366f1" }} />
              <span className="text-[10px] text-gray-500 uppercase tracking-widest truncate flex-1">
                {folderById(selectedFolderId)?.name}
              </span>
              <button onClick={() => setSelectedFolderId(null)} className="text-gray-600 hover:text-gray-400 text-xs shrink-0" title="Show all">✕</button>
            </div>
          )}
        </>
      ) : (
        <div className="px-3 pb-1 shrink-0 flex items-center justify-between">
          {selectedFolderId ? (
            <div className="flex items-center gap-1.5 flex-1 min-w-0">
              <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: folderById(selectedFolderId)?.color ?? "#6366f1" }} />
              <span className="text-[10px] text-gray-500 uppercase tracking-widest truncate">
                {folderById(selectedFolderId)?.name}
              </span>
              <button onClick={() => setSelectedFolderId(null)} className="text-gray-600 hover:text-gray-400 text-xs shrink-0">✕</button>
            </div>
          ) : (
            <span className="text-[10px] text-gray-600 uppercase tracking-widest">Notes</span>
          )}
          <button
            onClick={handleCreateNote}
            title="New note"
            className="text-indigo-400 hover:text-indigo-300 transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
          </button>
        </div>
      )}

      {/* ── List area ─────────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto min-h-0">

        {/* ── Meetings list ─────────────────────────────────────────────── */}
        {sidebarMode === "meetings" && (
          <>
            {meetings.length === 0 && (
              <p className="px-4 py-6 text-xs text-gray-600 text-center">
                {selectedFolderId ? "No recordings in this folder" : "No recordings yet"}
              </p>
            )}
            {meetings.map((m) => {
              const folder = folderById(m.folder_id ?? null);
              const activeBorderColor = folder?.color ?? "#6366f1";
              return (
                <div key={m.id} draggable onDragStart={(e) => handleDragStart(e, m.id)} onDragEnd={handleDragEnd}
                  className={`relative transition-opacity ${draggingMeetingId === m.id ? "opacity-40" : ""}`}>
                  {renamingMeeting === m.id ? (
                    <div className="px-3 py-2 border-b border-gray-800/60">
                      <input
                        autoFocus
                        value={renameMeetingDraft}
                        onChange={(e) => setRenameMeetingDraft(e.target.value)}
                        onBlur={() => handleRenameMeeting(m.id)}
                        onKeyDown={(e) => { if (e.key === "Enter") handleRenameMeeting(m.id); if (e.key === "Escape") setRenamingMeeting(null); }}
                        className="w-full bg-gray-800 border border-indigo-500 rounded px-2 py-0.5 text-xs text-white focus:outline-none"
                      />
                    </div>
                  ) : (
                    <button
                      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setContextMenu({ x: e.clientX, y: e.clientY, meeting: m }); }}
                      onClick={() => onNavigate({ kind: "meeting", id: m.id })}
                      className={`w-full text-left px-3 py-2.5 border-b border-gray-800/60 transition-colors cursor-grab active:cursor-grabbing ${
                        activeId === m.id ? "bg-gray-800" : "hover:bg-gray-800/50"
                      }`}
                      style={activeId === m.id ? { borderLeft: `2px solid ${activeBorderColor}` } : {}}
                    >
                      {m.is_pinned && <span className="text-amber-400 text-[10px] block mb-0.5">📌</span>}
                      <p className="text-xs font-medium text-gray-200 leading-tight line-clamp-2">{m.title}</p>
                      <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                        <span className="text-[10px] text-gray-600">{formatDate(m.created_at)}</span>
                        {m.duration_seconds != null && (
                          <span className="text-[10px] text-gray-700">{formatTime(m.duration_seconds)}</span>
                        )}
                        {!selectedFolderId && folder && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded font-medium leading-none"
                            style={{ background: folder.color + "28", color: folder.color }}>
                            {folder.name}
                          </span>
                        )}
                      </div>
                      {m.tags.length > 0 && (
                        <div className="flex gap-1 mt-1 flex-wrap">
                          {m.tags.slice(0, 3).map((tag) => (
                            <span key={tag.id} className="text-[9px] px-1.5 py-0.5 rounded font-medium leading-tight"
                              style={{ background: tag.color + "28", color: tag.color }}>
                              {tag.name}
                            </span>
                          ))}
                          {m.tags.length > 3 && <span className="text-[9px] text-gray-600">+{m.tags.length - 3}</span>}
                        </div>
                      )}
                    </button>
                  )}
                </div>
              );
            })}
          </>
        )}

        {/* ── Notes list ────────────────────────────────────────────────── */}
        {sidebarMode === "notes" && (
          <>
            {notes.length === 0 && (
              <div className="px-4 py-6 text-center">
                <p className="text-xs text-gray-600 mb-3">
                  {selectedFolderId ? "No notes in this folder" : "No notes yet"}
                </p>
                <button onClick={handleCreateNote}
                  className="text-xs text-indigo-400 hover:text-indigo-300 border border-dashed border-indigo-800 hover:border-indigo-600 rounded-lg px-3 py-1.5 transition-colors">
                  + New Note
                </button>
              </div>
            )}
            {notes.map((note) => {
              const folder = folderById(note.folder_id ?? null);
              const activeBorderColor = folder?.color ?? "#6366f1";
              return (
                <div key={note.id} draggable onDragStart={(e) => handleNoteDragStart(e, note.id)} onDragEnd={handleNoteDragEnd}
                  className={`relative transition-opacity ${draggingNoteId === note.id ? "opacity-40" : ""}`}>
                  {renamingNote === note.id ? (
                    <div className="px-3 py-2 border-b border-gray-800/60">
                      <input
                        autoFocus
                        value={renameNoteDraft}
                        onChange={(e) => setRenameNoteDraft(e.target.value)}
                        onBlur={() => handleRenameNote(note.id)}
                        onKeyDown={(e) => { if (e.key === "Enter") handleRenameNote(note.id); if (e.key === "Escape") setRenamingNote(null); }}
                        className="w-full bg-gray-800 border border-indigo-500 rounded px-2 py-0.5 text-xs text-white focus:outline-none"
                      />
                    </div>
                  ) : (
                    <button
                      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setNoteContextMenu({ x: e.clientX, y: e.clientY, note }); }}
                      onClick={() => onNavigate({ kind: "note", id: note.id })}
                      className={`w-full text-left px-3 py-2.5 border-b border-gray-800/60 transition-colors cursor-grab active:cursor-grabbing ${
                        activeNoteId === note.id ? "bg-gray-800" : "hover:bg-gray-800/50"
                      }`}
                      style={activeNoteId === note.id ? { borderLeft: `2px solid ${activeBorderColor}` } : {}}
                    >
                      <div className="flex items-center gap-1.5">
                        <svg className="w-3 h-3 text-gray-600 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
                            d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                        </svg>
                        <p className="text-xs font-medium text-gray-200 leading-tight line-clamp-2 flex-1">{note.title}</p>
                      </div>
                      <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                        <span className="text-[10px] text-gray-600">{formatDate(note.updated_at)}</span>
                        {!selectedFolderId && folder && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded font-medium leading-none"
                            style={{ background: folder.color + "28", color: folder.color }}>
                            {folder.name}
                          </span>
                        )}
                      </div>
                    </button>
                  )}
                </div>
              );
            })}
          </>
        )}
      </div>

      {/* Trash */}
      <div className="shrink-0 px-2 pb-2 border-t border-gray-800 pt-2">
        <button
          onClick={() => onNavigate({ kind: "trash" })}
          className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs transition-colors ${
            view.kind === "trash" ? "bg-gray-800 text-gray-200" : "text-gray-600 hover:text-gray-400 hover:bg-gray-800/50"
          }`}
        >
          <svg className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
              d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
          <span>Trash</span>
        </button>
      </div>

      {/* ── Meeting context menu ─────────────────────────────────────────────── */}
      {contextMenu && (
        <div ref={contextMenuRef} className="fixed z-50 bg-gray-800 border border-gray-700 rounded-lg shadow-xl py-1 min-w-[180px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}>
          <button className="w-full text-left px-3 py-1.5 text-xs text-gray-200 hover:bg-gray-700"
            onClick={() => { onNavigate({ kind: "meeting", id: contextMenu.meeting.id }); setContextMenu(null); }}>Open</button>
          <button className="w-full text-left px-3 py-1.5 text-xs text-gray-200 hover:bg-gray-700"
            onClick={() => { setRenamingMeeting(contextMenu.meeting.id); setRenameMeetingDraft(contextMenu.meeting.title); setContextMenu(null); }}>Rename</button>
          <button className="w-full text-left px-3 py-1.5 text-xs text-gray-200 hover:bg-gray-700"
            onClick={() => handleTogglePin(contextMenu.meeting)}>
            {contextMenu.meeting.is_pinned ? "Unpin" : "Pin to top"}
          </button>
          <div className="border-t border-gray-700 my-1" />
          <p className="px-3 py-0.5 text-[10px] text-gray-600 uppercase tracking-widest">Tags</p>
          <div className="max-h-36 overflow-y-auto">
            {allTags.map((tag) => {
              const checked = contextMenuTagIds.includes(tag.id);
              return (
                <button key={tag.id} className="w-full text-left px-3 py-1.5 text-xs text-gray-200 hover:bg-gray-700 flex items-center gap-2"
                  onClick={() => handleToggleMeetingTag(tag.id)}>
                  <span className="w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0 text-[8px] font-bold text-white"
                    style={checked ? { background: tag.color, borderColor: tag.color } : { borderColor: "#4b5563" }}>
                    {checked ? "✓" : ""}
                  </span>
                  <span className="flex-1 truncate">{tag.name}</span>
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ background: tag.color }} />
                </button>
              );
            })}
          </div>
          {showCreateTagInMenu ? (
            <div className="px-3 py-2 space-y-1.5 border-t border-gray-700 mt-1">
              <input autoFocus value={menuTagName} onChange={(e) => setMenuTagName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleCreateTagFromMenu(); if (e.key === "Escape") setShowCreateTagInMenu(false); }}
                placeholder="Tag name…"
                className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1 text-xs text-white placeholder-gray-500 focus:outline-none" />
              <div className="flex gap-1 flex-wrap">
                {TAG_COLORS.map((c) => (
                  <button key={c} onClick={() => setMenuTagColor(c)}
                    className={`w-3.5 h-3.5 rounded-full ${menuTagColor === c ? "ring-1 ring-white" : ""}`}
                    style={{ background: c }} />
                ))}
              </div>
              <div className="flex gap-1">
                <button onClick={handleCreateTagFromMenu} className="flex-1 text-[10px] py-1 bg-indigo-600 hover:bg-indigo-700 text-white rounded">Create</button>
                <button onClick={() => setShowCreateTagInMenu(false)} className="text-[10px] py-1 px-2 text-gray-500 hover:text-gray-300">Cancel</button>
              </div>
            </div>
          ) : (
            <button className="w-full text-left px-3 py-1.5 text-xs text-gray-500 hover:bg-gray-700 flex items-center gap-1.5"
              onClick={() => setShowCreateTagInMenu(true)}>
              <span className="text-sm leading-none">+</span>New tag…
            </button>
          )}
          {folders.length > 0 && (
            <>
              <div className="border-t border-gray-700 my-1" />
              <p className="px-3 py-0.5 text-[10px] text-gray-600 uppercase tracking-widest">Move to folder</p>
              {contextMenu.meeting.folder_id && (
                <button className="w-full text-left px-3 py-1.5 text-xs text-gray-400 hover:bg-gray-700"
                  onClick={() => handleMoveToFolder(contextMenu.meeting.id, null)}>Remove from folder</button>
              )}
              {folders.map((f) => (
                <button key={f.id} className="w-full text-left px-3 py-1.5 text-xs text-gray-200 hover:bg-gray-700 flex items-center gap-2"
                  onClick={() => handleMoveToFolder(contextMenu.meeting.id, f.id)}>
                  <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: f.color }} />{f.name}
                </button>
              ))}
            </>
          )}
          <div className="border-t border-gray-700 my-1" />
          <button className="w-full text-left px-3 py-1.5 text-xs text-red-400 hover:bg-gray-700"
            onClick={() => { setContextMenu(null); setConfirmDelete(contextMenu.meeting); }}>Move to Trash</button>
        </div>
      )}

      {/* ── Note context menu ────────────────────────────────────────────────── */}
      {noteContextMenu && (
        <div ref={noteContextMenuRef} className="fixed z-50 bg-gray-800 border border-gray-700 rounded-lg shadow-xl py-1 min-w-[160px]"
          style={{ left: noteContextMenu.x, top: noteContextMenu.y }}>
          <button className="w-full text-left px-3 py-1.5 text-xs text-gray-200 hover:bg-gray-700"
            onClick={() => { onNavigate({ kind: "note", id: noteContextMenu.note.id }); setNoteContextMenu(null); }}>Open</button>
          <button className="w-full text-left px-3 py-1.5 text-xs text-gray-200 hover:bg-gray-700"
            onClick={() => { setRenamingNote(noteContextMenu.note.id); setRenameNoteDraft(noteContextMenu.note.title); setNoteContextMenu(null); }}>Rename</button>
          {folders.length > 0 && (
            <>
              <div className="border-t border-gray-700 my-1" />
              <p className="px-3 py-0.5 text-[10px] text-gray-600 uppercase tracking-widest">Move to folder</p>
              {noteContextMenu.note.folder_id && (
                <button className="w-full text-left px-3 py-1.5 text-xs text-gray-400 hover:bg-gray-700"
                  onClick={() => handleMoveNoteToFolder(noteContextMenu.note.id, null)}>Remove from folder</button>
              )}
              {folders.map((f) => (
                <button key={f.id} className="w-full text-left px-3 py-1.5 text-xs text-gray-200 hover:bg-gray-700 flex items-center gap-2"
                  onClick={() => handleMoveNoteToFolder(noteContextMenu.note.id, f.id)}>
                  <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: f.color }} />{f.name}
                </button>
              ))}
            </>
          )}
          <div className="border-t border-gray-700 my-1" />
          <button className="w-full text-left px-3 py-1.5 text-xs text-red-400 hover:bg-gray-700"
            onClick={() => handleDeleteNote(noteContextMenu.note.id)}>Delete</button>
        </div>
      )}

      {/* ── Meeting delete confirmation ──────────────────────────────────────── */}
      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-gray-800 border border-gray-700 rounded-xl shadow-2xl p-5 max-w-sm w-full mx-4">
            <h3 className="text-sm font-semibold text-white mb-2">Move to Trash?</h3>
            <p className="text-xs text-gray-400 mb-5 leading-relaxed">
              "{confirmDelete.title}" will be moved to Trash. You can restore it from there.
            </p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setConfirmDelete(null)} className="px-3 py-1.5 text-xs rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-200 transition-colors">Cancel</button>
              <button onClick={() => confirmDeleteMeeting(confirmDelete.id)} className="px-3 py-1.5 text-xs rounded-lg bg-red-600 hover:bg-red-700 text-white transition-colors">Move to Trash</button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}

function formatDate(isoStr: string): string {
  try {
    const d = new Date(isoStr.replace(" ", "T") + "Z");
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return isoStr.slice(0, 10);
  }
}
