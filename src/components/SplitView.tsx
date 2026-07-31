import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { NoteFile, AppView } from "../lib/types";
import RecordView from "./RecordView";
import NoteDetailView from "./NoteDetailView";

interface Props {
  onNavigate: (view: AppView) => void;
}

export default function SplitView({ onNavigate }: Props) {
  const [noteId, setNoteId] = useState<string | null>(null);
  const [split, setSplit] = useState(48);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  useEffect(() => {
    async function init() {
      try {
        const note = await invoke<NoteFile>("create_note");
        const title = `Notes — ${new Date().toLocaleDateString(undefined, {
          month: "short", day: "numeric", year: "numeric",
        })}`;
        await invoke("save_note", { args: { note_id: note.id, title, content: null } });
        window.dispatchEvent(new Event("scribe:reload-notes"));
        setNoteId(note.id);
      } catch { /* ignore */ }
    }
    init();
  }, []);

  function onDividerMouseDown(e: React.MouseEvent) {
    e.preventDefault();
    dragging.current = true;

    function onMove(ev: MouseEvent) {
      if (!dragging.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const pct = ((ev.clientX - rect.left) / rect.width) * 100;
      setSplit(Math.max(28, Math.min(72, pct)));
    }

    function onUp() {
      dragging.current = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  return (
    <div ref={containerRef} className="flex h-full overflow-hidden select-none">
      {/* Left — Recording */}
      <div style={{ width: `${split}%` }} className="min-w-0 overflow-hidden flex flex-col">
        <RecordView
          onMeetingReady={(id) => onNavigate({ kind: "meeting", id })}
          onNavigate={onNavigate}
        />
      </div>

      {/* Drag divider */}
      <div
        onMouseDown={onDividerMouseDown}
        className="w-1 shrink-0 cursor-col-resize bg-gray-800 hover:bg-indigo-600 active:bg-indigo-500 transition-colors"
      />

      {/* Right — Notes */}
      <div className="flex-1 min-w-0 overflow-hidden">
        {noteId ? (
          <NoteDetailView
            noteId={noteId}
            onDeleted={() => onNavigate({ kind: "home" })}
            onNavigate={onNavigate}
            compact
          />
        ) : (
          <div className="flex items-center justify-center h-full text-gray-700 text-sm">
            Creating note…
          </div>
        )}
      </div>
    </div>
  );
}
