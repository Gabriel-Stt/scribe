import { useEffect, useState } from "react";
import { AppView } from "./lib/types";
import Sidebar from "./components/Sidebar";
import RecordView from "./components/RecordView";
import MeetingView from "./components/MeetingView";
import SettingsView from "./components/SettingsView";

export default function App() {
  const [view, setView] = useState<AppView>({ kind: "home" });

  // Disable the native browser/webview context menu (removes "Inspect Element" etc.)
  useEffect(() => {
    const handler = (e: MouseEvent) => e.preventDefault();
    document.addEventListener("contextmenu", handler);
    return () => document.removeEventListener("contextmenu", handler);
  }, []);

  function handleMeetingReady(id: string) {
    setView({ kind: "meeting", id });
  }

  function renderMain() {
    switch (view.kind) {
      case "record":
        return (
          <RecordView
            onMeetingReady={handleMeetingReady}
            onNavigate={setView}
          />
        );
      case "meeting":
        return (
          <MeetingView
            meetingId={view.id}
            onDeleted={() => setView({ kind: "home" })}
          />
        );
      case "settings":
        return <SettingsView />;
      default:
        return <HomeHint onRecord={() => setView({ kind: "record" })} />;
    }
  }

  return (
    <div className="h-screen flex bg-gray-950 text-gray-100 overflow-hidden">
      <Sidebar view={view} onNavigate={setView} />
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {renderMain()}
      </main>
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
