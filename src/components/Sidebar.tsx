import { useEffect, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { MeetingListItem, AppView } from "../lib/types";
import { formatTime, SubjectPill } from "./shared";

interface SidebarProps {
  view: AppView;
  onNavigate: (view: AppView) => void;
}

export default function Sidebar({ view, onNavigate }: SidebarProps) {
  const [meetings, setMeetings] = useState<MeetingListItem[]>([]);
  const [search, setSearch] = useState("");

  const load = useCallback(async (q?: string) => {
    try {
      const items = await invoke<MeetingListItem[]>("list_meetings", {
        search: q || null,
      });
      setMeetings(items);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Reload whenever a new meeting is created or a title is auto-generated
  useEffect(() => {
    const unsubs = [
      listen("meeting-title-ready", () => load(search || undefined)),
    ];
    return () => {
      unsubs.forEach((p) => p.then((u) => u()));
    };
  }, [load, search]);

  // Expose reload so parent can call it after recording finishes
  useEffect(() => {
    const handler = () => load(search || undefined);
    window.addEventListener("scribe:reload-meetings", handler);
    return () => window.removeEventListener("scribe:reload-meetings", handler);
  }, [load, search]);

  useEffect(() => {
    const timer = setTimeout(() => load(search || undefined), 250);
    return () => clearTimeout(timer);
  }, [search, load]);

  const activeId = view.kind === "meeting" ? view.id : null;

  return (
    <aside className="w-60 shrink-0 flex flex-col bg-gray-900 border-r border-gray-800 h-full">
      {/* Header */}
      <div className="px-4 pt-5 pb-3 flex items-center justify-between">
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
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.8}
              d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
            />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        </button>
      </div>

      {/* New Recording button */}
      <div className="px-3 pb-3">
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
      <div className="px-3 pb-2">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search meetings…"
          className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-indigo-500"
        />
      </div>

      {/* Meetings list */}
      <div className="flex-1 overflow-y-auto">
        {meetings.length === 0 && (
          <p className="px-4 py-6 text-xs text-gray-600 text-center">No recordings yet</p>
        )}
        {meetings.map((m) => (
          <button
            key={m.id}
            onClick={() => onNavigate({ kind: "meeting", id: m.id })}
            className={`w-full text-left px-3 py-2.5 border-b border-gray-800/60 transition-colors ${
              activeId === m.id
                ? "bg-gray-800 border-l-2 border-l-indigo-500"
                : "hover:bg-gray-800/50"
            }`}
          >
            <p className="text-xs font-medium text-gray-200 leading-tight line-clamp-2">
              {m.title}
            </p>
            <div className="flex items-center gap-2 mt-1">
              <span className="text-[10px] text-gray-600">
                {formatDate(m.created_at)}
              </span>
              {m.duration_seconds != null && (
                <span className="text-[10px] text-gray-700">
                  {formatTime(m.duration_seconds)}
                </span>
              )}
              {m.subject_tag && <SubjectPill tag={m.subject_tag} />}
            </div>
          </button>
        ))}
      </div>
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
