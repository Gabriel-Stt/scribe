import { useEffect, useState, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { AppView, SplitPanel } from "./lib/types";
import Sidebar from "./components/Sidebar";
import RecordView from "./components/RecordView";
import MeetingView from "./components/MeetingView";
import SettingsView from "./components/SettingsView";
import TrashView from "./components/TrashView";
import NoteDetailView from "./components/NoteDetailView";
import ChatView from "./components/ChatView";
import SearchModal from "./components/SearchModal";
import SplitButton, { CollapseButton } from "./components/SplitButton";

function noteIdsInView(v: AppView): string[] {
  const ids: string[] = [];
  if (v.kind === "note") ids.push(v.id);
  if (v.kind === "split") {
    if (v.left.kind === "note")  ids.push(v.left.id);
    if (v.right.kind === "note") ids.push(v.right.id);
  }
  return ids;
}

export default function App() {
  const [view, setView] = useState<AppView>({ kind: "home" });
  const [showSearch, setShowSearch] = useState(false);
  const [recordingPhase, setRecordingPhase] = useState<string>("idle");
  const [splitPercent, setSplitPercent] = useState(48);
  const mainRef = useRef<HTMLDivElement>(null);
  const splitDragging = useRef(false);

  // chatSessionId persists the active session so ChatView stays mounted
  // and streaming survives navigation away from the chat view.
  const [chatSessionId, setChatSessionId] = useState<string | null>(null);
  useEffect(() => {
    if (view.kind === "chat") {
      setChatSessionId(view.sessionId);
    } else if (view.kind === "split") {
      if (view.left.kind === "chat")  setChatSessionId(view.left.sessionId);
      if (view.right.kind === "chat") setChatSessionId(view.right.sessionId);
    }
  }, [view]);

  // Delete any note that was just closed if it has no content
  const prevViewRef = useRef<AppView>(view);
  useEffect(() => {
    const prev = prevViewRef.current;
    prevViewRef.current = view;
    const curr = noteIdsInView(view);
    const departed = noteIdsInView(prev).filter((id) => !curr.includes(id));
    for (const noteId of departed) {
      invoke<boolean>("delete_note_if_empty", { noteId })
        .then((deleted) => { if (deleted) window.dispatchEvent(new Event("scribe:reload-notes")); })
        .catch(() => {});
    }
  }, [view]);

  // Derived split panel references
  const isSplit     = view.kind === "split";
  const splitLeft   = view.kind === "split" ? view.left  : null;
  const splitRight  = view.kind === "split" ? view.right : null;

  const recordIsLeft  = splitLeft?.kind  === "record";
  const recordIsRight = splitRight?.kind === "record";
  const chatIsLeft    = splitLeft?.kind  === "chat";
  const chatIsRight   = splitRight?.kind === "chat";

  const showRecordPanel = view.kind === "record" || recordIsLeft || recordIsRight;
  const showChatPanel   = view.kind === "chat"   || chatIsLeft  || chatIsRight;

  // Track recording phase
  useEffect(() => {
    const h = (e: Event) => setRecordingPhase((e as CustomEvent).detail);
    window.addEventListener("scribe:phase-change", h);
    return () => window.removeEventListener("scribe:phase-change", h);
  }, []);

  // Apply saved theme
  useEffect(() => {
    const theme = localStorage.getItem("theme") ?? "dark";
    document.documentElement.className = theme;
  }, []);

  // Disable native context menu
  useEffect(() => {
    const h = (e: MouseEvent) => e.preventDefault();
    document.addEventListener("contextmenu", h);
    return () => document.removeEventListener("contextmenu", h);
  }, []);

  // Cmd+K global search
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setShowSearch((v) => !v);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  // Forward Tauri recording shortcut
  useEffect(() => {
    const unlisten = listen("recording-shortcut", () => {
      window.dispatchEvent(new Event("scribe:recording-shortcut"));
    });
    return () => { unlisten.then((u) => u()); };
  }, []);

  // Split drag-to-resize
  function handleSplitDrag(e: React.MouseEvent) {
    e.preventDefault();
    splitDragging.current = true;
    function onMove(ev: MouseEvent) {
      if (!splitDragging.current || !mainRef.current) return;
      const rect = mainRef.current.getBoundingClientRect();
      const pct = ((ev.clientX - rect.left) / rect.width) * 100;
      setSplitPercent(Math.max(25, Math.min(75, pct)));
    }
    function onUp() {
      splitDragging.current = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  // Render a dynamic panel (meeting or note — record/chat handled by always-mounted divs)
  function renderPanel(panel: SplitPanel): React.ReactNode {
    switch (panel.kind) {
      case "meeting":
        return <MeetingView meetingId={panel.id} onDeleted={() => setView({ kind: "home" })} onNavigate={setView} />;
      case "note":
        return <NoteDetailView noteId={panel.id} onDeleted={() => setView({ kind: "home" })} onNavigate={setView} compact />;
      default:
        return null;
    }
  }

  // Single-view content (not split, not record, not chat)
  function renderSingleView(): React.ReactNode {
    switch (view.kind) {
      case "meeting":
        return <MeetingView meetingId={view.id} onDeleted={() => setView({ kind: "home" })} onNavigate={setView} />;
      case "note":
        return <NoteDetailView noteId={view.id} onDeleted={() => setView({ kind: "home" })} onNavigate={setView} />;
      case "settings":
        return <SettingsView />;
      case "trash":
        return <TrashView />;
      default:
        return <HomeHint onRecord={() => setView({ kind: "record" })} />;
    }
  }

  return (
    <div className="h-screen flex bg-gray-950 text-gray-100 overflow-hidden select-none">
      <Sidebar view={view} onNavigate={setView} recordingPhase={recordingPhase} />

      <main ref={mainRef} className="flex-1 flex min-w-0 overflow-hidden">

        {/* ── RecordView — always mounted ─────────────────────────────────── */}
        <div
          className={`group relative overflow-hidden flex flex-col ${showRecordPanel ? "" : "hidden"}`}
          style={
            !showRecordPanel      ? {} :
            isSplit && recordIsLeft  ? { order: 0, width: `${splitPercent}%`, minWidth: 0 } :
            isSplit && recordIsRight ? { order: 2, flex: 1,  minWidth: 0 } :
            { flex: 1, minWidth: 0 }
          }
        >
          <RecordView
            onMeetingReady={(id) => setView({ kind: "meeting", id })}
            onNavigate={setView}
          />
          {view.kind === "record" && !isSplit && (
            <SplitButton currentPanel={{ kind: "record" }} onNavigate={setView} />
          )}
          {isSplit && (recordIsLeft || recordIsRight) && (
            <CollapseButton panel={{ kind: "record" }} onNavigate={(v) => setView(v)} />
          )}
        </div>

        {/* ── ChatView — always mounted ────────────────────────────────────── */}
        <div
          className={`group relative overflow-hidden flex ${showChatPanel ? "" : "hidden"}`}
          style={
            !showChatPanel      ? {} :
            isSplit && chatIsLeft  ? { order: 0, width: `${splitPercent}%`, minWidth: 0 } :
            isSplit && chatIsRight ? { order: 2, flex: 1,  minWidth: 0 } :
            { flex: 1, minWidth: 0 }
          }
        >
          <ChatView sessionId={chatSessionId} onNavigate={setView} />
          {view.kind === "chat" && !isSplit && (
            <SplitButton currentPanel={{ kind: "chat", sessionId: chatSessionId }} onNavigate={setView} />
          )}
          {isSplit && (chatIsLeft || chatIsRight) && (
            <CollapseButton
              panel={{ kind: "chat", sessionId: chatSessionId }}
              onNavigate={(v) => setView(v)}
            />
          )}
        </div>

        {/* ── Split divider ────────────────────────────────────────────────── */}
        {isSplit && (
          <div
            className="w-1 shrink-0 cursor-col-resize bg-gray-800 hover:bg-indigo-600 active:bg-indigo-500 transition-colors"
            style={{ order: 1 }}
            onMouseDown={handleSplitDrag}
          />
        )}

        {/* ── Dynamic left split panel (meeting or note) ───────────────────── */}
        {isSplit && splitLeft && splitLeft.kind !== "record" && splitLeft.kind !== "chat" && (
          <div
            className="group relative overflow-hidden flex flex-col"
            style={{ order: 0, width: `${splitPercent}%`, minWidth: 0 }}
          >
            {renderPanel(splitLeft)}
            <CollapseButton panel={splitLeft} onNavigate={setView} />
          </div>
        )}

        {/* ── Dynamic right split panel (meeting or note) ──────────────────── */}
        {isSplit && splitRight && splitRight.kind !== "record" && splitRight.kind !== "chat" && (
          <div
            className="group relative overflow-hidden flex flex-col"
            style={{ order: 2, flex: 1, minWidth: 0 }}
          >
            {renderPanel(splitRight)}
            <CollapseButton panel={splitRight} onNavigate={setView} />
          </div>
        )}

        {/* ── Single view (non-split, non-record, non-chat) ───────────────── */}
        {!isSplit && !showRecordPanel && !showChatPanel && (
          <div className="group relative flex-1 flex flex-col min-w-0 overflow-hidden">
            {renderSingleView()}
            {view.kind === "meeting" && (
              <SplitButton currentPanel={{ kind: "meeting", id: view.id }} onNavigate={setView} />
            )}
            {view.kind === "note" && (
              <SplitButton currentPanel={{ kind: "note", id: view.id }} onNavigate={setView} />
            )}
          </div>
        )}
      </main>

      {showSearch && (
        <SearchModal
          onNavigate={(v) => { setView(v); setShowSearch(false); }}
          onClose={() => setShowSearch(false)}
        />
      )}
    </div>
  );
}

function HomeHint({ onRecord }: { onRecord: () => void }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-5 text-center p-8">
      <div className="w-14 h-14 rounded-full bg-indigo-600/20 flex items-center justify-center">
        <span className="text-2xl text-indigo-400">●</span>
      </div>
      <div>
        <h2 className="text-lg font-semibold text-white mb-1">Ready to capture</h2>
        <p className="text-sm text-gray-500 max-w-xs">
          Start a new recording, or select a past meeting from the sidebar.
        </p>
      </div>
      <button onClick={onRecord} className="btn-primary text-base px-6 py-3">
        New Recording
      </button>
    </div>
  );
}
