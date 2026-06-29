import { useEffect, useState, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { MeetingListItem, Folder, AppView } from "../lib/types";
import { formatTime } from "./shared";

interface SidebarProps {
  view: AppView;
  onNavigate: (view: AppView) => void;
}

interface ContextMenuState {
  x: number;
  y: number;
  meeting: MeetingListItem;
}

const FOLDER_COLORS = [
  "#6366f1", "#8b5cf6", "#ec4899", "#ef4444",
  "#f97316", "#eab308", "#22c55e", "#14b8a6",
  "#3b82f6", "#06b6d4",
];

export default function Sidebar({ view, onNavigate }: SidebarProps) {
  const [meetings, setMeetings] = useState<MeetingListItem[]>([]);
  const [search, setSearch] = useState("");
  const [folders, setFolders] = useState<Folder[]>([]);
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [newFolderColor, setNewFolderColor] = useState(FOLDER_COLORS[0]);
  const [renamingFolder, setRenamingFolder] = useState<string | null>(null);
  const [renameFolderDraft, setRenameFolderDraft] = useState("");
  const [renamingMeeting, setRenamingMeeting] = useState<string | null>(null);
  const [renameMeetingDraft, setRenameMeetingDraft] = useState("");
  const [draggingMeetingId, setDraggingMeetingId] = useState<string | null>(null);
  const [dragOverTarget, setDragOverTarget] = useState<string | "all" | null>(null);
  const newFolderInputRef = useRef<HTMLInputElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  const loadMeetings = useCallback(async (q?: string, fid?: string | null) => {
    try {
      const items = await invoke<MeetingListItem[]>("list_meetings", {
        search: q || null,
        folderId: fid !== undefined ? fid : selectedFolderId,
      });
      setMeetings(items);
    } catch {
      // ignore
    }
  }, [selectedFolderId]);

  const loadFolders = useCallback(async () => {
    try {
      const f = await invoke<Folder[]>("list_folders");
      setFolders(f);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => { loadFolders(); }, [loadFolders]);

  useEffect(() => {
    loadMeetings(search || undefined, selectedFolderId);
  }, [search, selectedFolderId, loadMeetings]);

  useEffect(() => {
    const unsubs = [listen("meeting-title-ready", () => loadMeetings(search || undefined))];
    return () => { unsubs.forEach((p) => p.then((u) => u())); };
  }, [loadMeetings, search]);

  useEffect(() => {
    const handler = () => loadMeetings(search || undefined);
    window.addEventListener("scribe:reload-meetings", handler);
    return () => window.removeEventListener("scribe:reload-meetings", handler);
  }, [loadMeetings, search]);

  useEffect(() => {
    if (!contextMenu) return;
    const handler = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [contextMenu]);

  useEffect(() => {
    if (showNewFolder) newFolderInputRef.current?.focus();
  }, [showNewFolder]);

  const activeId = view.kind === "meeting" ? view.id : null;

  async function handleCreateFolder() {
    if (!newFolderName.trim()) return;
    try {
      await invoke("create_folder", { args: { name: newFolderName.trim(), color: newFolderColor } });
      setNewFolderName("");
      setNewFolderColor(FOLDER_COLORS[0]);
      setShowNewFolder(false);
      loadFolders();
    } catch { /* ignore */ }
  }

  async function handleDeleteFolder(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    await invoke("delete_folder", { folderId: id });
    if (selectedFolderId === id) setSelectedFolderId(null);
    loadFolders();
    loadMeetings(search || undefined, null);
  }

  async function handleRenameFolder(id: string) {
    if (!renameFolderDraft.trim()) { setRenamingFolder(null); return; }
    await invoke("rename_folder", { args: { id, name: renameFolderDraft.trim() } });
    setRenamingFolder(null);
    loadFolders();
  }

  async function handleMoveToFolder(meetingId: string, folderId: string | null) {
    await invoke("assign_meeting_folder", { meetingId, folderId });
    setContextMenu(null);
    loadMeetings(search || undefined);
    window.dispatchEvent(new Event("scribe:reload-meetings"));
  }

  async function handleRenameMeeting(id: string) {
    if (!renameMeetingDraft.trim()) { setRenamingMeeting(null); return; }
    await invoke("update_meeting", { args: { id, title: renameMeetingDraft.trim(), subject_tag: null } });
    setRenamingMeeting(null);
    loadMeetings(search || undefined);
    window.dispatchEvent(new Event("scribe:reload-meetings"));
  }

  async function handleDeleteMeeting(id: string) {
    setContextMenu(null);
    await invoke("delete_meeting", { meetingId: id });
    if (view.kind === "meeting" && view.id === id) onNavigate({ kind: "home" });
    loadMeetings(search || undefined);
    window.dispatchEvent(new Event("scribe:reload-meetings"));
  }

  function openContextMenu(e: React.MouseEvent, meeting: MeetingListItem) {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, meeting });
  }

  // Drag-and-drop handlers
  function handleDragStart(e: React.DragEvent, meetingId: string) {
    setDraggingMeetingId(meetingId);
    e.dataTransfer.setData("meetingId", meetingId);
    e.dataTransfer.effectAllowed = "move";
  }

  function handleDragEnd() {
    setDraggingMeetingId(null);
    setDragOverTarget(null);
  }

  function handleFolderDragOver(e: React.DragEvent, target: string | "all") {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverTarget(target);
  }

  function handleFolderDragLeave(e: React.DragEvent) {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setDragOverTarget(null);
    }
  }

  function handleFolderDrop(e: React.DragEvent, folderId: string | null) {
    e.preventDefault();
    const meetingId = e.dataTransfer.getData("meetingId");
    if (meetingId) handleMoveToFolder(meetingId, folderId);
    setDragOverTarget(null);
    setDraggingMeetingId(null);
  }

  const folderById = (id: string | null) => folders.find((f) => f.id === id);

  return (
    <aside className="w-60 shrink-0 flex flex-col bg-gray-900 border-r border-gray-800 h-full select-none">
      {/* Header */}
      <div className="px-4 pt-5 pb-3 flex items-center justify-between shrink-0">
        <span className="text-sm font-semibold text-white tracking-tight">Scribe</span>
        <button
          onClick={() => onNavigate({ kind: "settings" })}
          title="Settings"
          className={`p-1.5 rounded-lg transition-colors ${
            view.kind === "settings"
              ? "bg-gray-700 text-white"
              : "text-gray-500 hover:text-gray-300 hover:bg-gray-800"
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
      <div className="px-3 pb-3 shrink-0">
        <button
          onClick={() => onNavigate({ kind: "record" })}
          className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
            view.kind === "record"
              ? "bg-indigo-600 text-white"
              : "bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-300"
          }`}
        >
          <span className="text-base leading-none">●</span>
          New Recording
        </button>
      </div>

      {/* Search */}
      <div className="px-3 pb-2 shrink-0">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search meetings…"
          className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-indigo-500"
        />
      </div>

      {/* Folder navigation — above the meetings list */}
      <div className="px-2 pb-2 shrink-0">
        {/* All Meetings */}
        <div
          onClick={() => setSelectedFolderId(null)}
          onDragOver={(e) => handleFolderDragOver(e, "all")}
          onDragLeave={handleFolderDragLeave}
          onDrop={(e) => handleFolderDrop(e, null)}
          className={`flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer transition-colors text-xs font-medium ${
            selectedFolderId === null
              ? "bg-gray-800 text-gray-200"
              : "text-gray-500 hover:text-gray-300 hover:bg-gray-800/50"
          } ${dragOverTarget === "all" ? "ring-1 ring-indigo-400 bg-indigo-900/30" : ""}`}
        >
          <svg className="w-3.5 h-3.5 shrink-0 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h16M4 18h16" />
          </svg>
          <span className="truncate">All Meetings</span>
        </div>

        {/* Folder items */}
        <div className="mt-0.5 space-y-0.5 max-h-44 overflow-y-auto">
          {folders.map((f) => (
            <div
              key={f.id}
              onDragOver={(e) => handleFolderDragOver(e, f.id)}
              onDragLeave={handleFolderDragLeave}
              onDrop={(e) => handleFolderDrop(e, f.id)}
              className="group flex items-center gap-1 rounded-lg transition-colors"
              style={dragOverTarget === f.id
                ? { boxShadow: `0 0 0 1px ${f.color}`, backgroundColor: f.color + "22" }
                : {}}
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
                    selectedFolderId === f.id
                      ? "bg-gray-800 text-gray-200"
                      : "text-gray-500 hover:text-gray-300 hover:bg-gray-800/50"
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

        {/* New folder form / button */}
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
                <button
                  key={c}
                  onClick={() => setNewFolderColor(c)}
                  className={`w-4 h-4 rounded-full transition-transform ${newFolderColor === c ? "ring-2 ring-white scale-110" : ""}`}
                  style={{ background: c }}
                />
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

      {/* Divider between nav and meeting list */}
      <div className="border-t border-gray-800 mx-3 mb-1 shrink-0" />

      {/* Section label */}
      {selectedFolderId ? (
        <div className="px-3 pb-1 flex items-center gap-1.5 shrink-0">
          <span
            className="w-2 h-2 rounded-sm shrink-0"
            style={{ background: folderById(selectedFolderId)?.color ?? "#6366f1" }}
          />
          <span className="text-[10px] text-gray-500 uppercase tracking-widest truncate flex-1">
            {folderById(selectedFolderId)?.name}
          </span>
          <button
            onClick={() => setSelectedFolderId(null)}
            className="text-gray-600 hover:text-gray-400 text-xs shrink-0"
            title="Show all meetings"
          >✕</button>
        </div>
      ) : null}

      {/* Meetings list */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {meetings.length === 0 && (
          <p className="px-4 py-6 text-xs text-gray-600 text-center">
            {selectedFolderId ? "No recordings in this folder" : "No recordings yet"}
          </p>
        )}
        {meetings.map((m) => (
          <div
            key={m.id}
            draggable
            onDragStart={(e) => handleDragStart(e, m.id)}
            onDragEnd={handleDragEnd}
            className={`relative transition-opacity ${draggingMeetingId === m.id ? "opacity-40" : ""}`}
          >
            {renamingMeeting === m.id ? (
              <div className="px-3 py-2 border-b border-gray-800/60">
                <input
                  autoFocus
                  value={renameMeetingDraft}
                  onChange={(e) => setRenameMeetingDraft(e.target.value)}
                  onBlur={() => handleRenameMeeting(m.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleRenameMeeting(m.id);
                    if (e.key === "Escape") setRenamingMeeting(null);
                  }}
                  className="w-full bg-gray-800 border border-indigo-500 rounded px-2 py-0.5 text-xs text-white focus:outline-none"
                />
              </div>
            ) : (
              <button
                onContextMenu={(e) => openContextMenu(e, m)}
                onClick={() => onNavigate({ kind: "meeting", id: m.id })}
                className={`w-full text-left px-3 py-2.5 border-b border-gray-800/60 transition-colors cursor-grab active:cursor-grabbing ${
                  activeId === m.id
                    ? "bg-gray-800 border-l-2 border-l-indigo-500"
                    : "hover:bg-gray-800/50"
                }`}
              >
                <p className="text-xs font-medium text-gray-200 leading-tight line-clamp-2">
                  {m.title}
                </p>
                <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                  <span className="text-[10px] text-gray-600">{formatDate(m.created_at)}</span>
                  {m.duration_seconds != null && (
                    <span className="text-[10px] text-gray-700">{formatTime(m.duration_seconds)}</span>
                  )}
                  {/* Show folder pill only when viewing all meetings */}
                  {!selectedFolderId && m.folder_id && (() => {
                    const f = folderById(m.folder_id);
                    return f ? (
                      <span
                        className="text-[10px] px-1.5 py-0.5 rounded font-medium leading-none"
                        style={{ background: f.color + "28", color: f.color }}
                      >
                        {f.name}
                      </span>
                    ) : null;
                  })()}
                </div>
              </button>
            )}
          </div>
        ))}
      </div>

      {/* Context menu */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="fixed z-50 bg-gray-800 border border-gray-700 rounded-lg shadow-xl py-1 min-w-[160px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            className="w-full text-left px-3 py-1.5 text-xs text-gray-200 hover:bg-gray-700"
            onClick={() => {
              onNavigate({ kind: "meeting", id: contextMenu.meeting.id });
              setContextMenu(null);
            }}
          >Open</button>
          <button
            className="w-full text-left px-3 py-1.5 text-xs text-gray-200 hover:bg-gray-700"
            onClick={() => {
              setRenamingMeeting(contextMenu.meeting.id);
              setRenameMeetingDraft(contextMenu.meeting.title);
              setContextMenu(null);
            }}
          >Rename</button>
          {folders.length > 0 && (
            <>
              <div className="border-t border-gray-700 my-1" />
              <p className="px-3 py-0.5 text-[10px] text-gray-600 uppercase tracking-widest">Move to folder</p>
              {contextMenu.meeting.folder_id && (
                <button
                  className="w-full text-left px-3 py-1.5 text-xs text-gray-400 hover:bg-gray-700"
                  onClick={() => handleMoveToFolder(contextMenu.meeting.id, null)}
                >Remove from folder</button>
              )}
              {folders.map((f) => (
                <button
                  key={f.id}
                  className="w-full text-left px-3 py-1.5 text-xs text-gray-200 hover:bg-gray-700 flex items-center gap-2"
                  onClick={() => handleMoveToFolder(contextMenu.meeting.id, f.id)}
                >
                  <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: f.color }} />
                  {f.name}
                </button>
              ))}
            </>
          )}
          <div className="border-t border-gray-700 my-1" />
          <button
            className="w-full text-left px-3 py-1.5 text-xs text-red-400 hover:bg-gray-700"
            onClick={() => handleDeleteMeeting(contextMenu.meeting.id)}
          >Delete</button>
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
