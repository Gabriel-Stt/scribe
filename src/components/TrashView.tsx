import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { MeetingListItem } from "../lib/types";
import { formatTime } from "./shared";

export default function TrashView() {
  const [items, setItems] = useState<MeetingListItem[]>([]);
  const [confirmPermanent, setConfirmPermanent] = useState<MeetingListItem | null>(null);
  const [confirmEmptyAll, setConfirmEmptyAll] = useState(false);

  async function load() {
    try {
      const rows = await invoke<MeetingListItem[]>("list_trashed_meetings");
      setItems(rows);
    } catch { /* ignore */ }
  }

  useEffect(() => { load(); }, []);

  async function handleRestore(id: string) {
    await invoke("restore_meeting", { meetingId: id });
    window.dispatchEvent(new Event("scribe:reload-meetings"));
    load();
  }

  async function handlePermanentDelete(id: string) {
    await invoke("permanently_delete_meeting", { meetingId: id });
    setConfirmPermanent(null);
    load();
  }

  async function handleEmptyTrash() {
    for (const item of items) {
      await invoke("permanently_delete_meeting", { meetingId: item.id });
    }
    setConfirmEmptyAll(false);
    load();
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800 shrink-0">
        <div className="flex items-center gap-2">
          <svg className="w-4 h-4 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
              d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
          <h2 className="text-sm font-semibold text-gray-200">Trash</h2>
          {items.length > 0 && (
            <span className="text-xs text-gray-600 ml-1">({items.length})</span>
          )}
        </div>
        {items.length > 0 && (
          <button
            onClick={() => setConfirmEmptyAll(true)}
            className="text-xs text-red-500 hover:text-red-400 transition-colors"
          >
            Empty Trash
          </button>
        )}
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {items.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-center p-8">
            <div className="w-12 h-12 rounded-full bg-gray-800 flex items-center justify-center">
              <svg className="w-5 h-5 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
                  d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </div>
            <p className="text-sm text-gray-600">Trash is empty</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-800">
            {items.map((item) => (
              <div key={item.id} className="flex items-center gap-3 px-6 py-3 hover:bg-gray-900/50 group">
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-gray-300 truncate">{item.title}</p>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-xs text-gray-600">{formatTrashedDate(item.deleted_at)}</span>
                    {item.duration_seconds != null && (
                      <span className="text-xs text-gray-700">{formatTime(item.duration_seconds)}</span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={() => handleRestore(item.id)}
                    className="text-xs px-2.5 py-1 rounded bg-gray-700 hover:bg-gray-600 text-gray-200 transition-colors"
                  >
                    Restore
                  </button>
                  <button
                    onClick={() => setConfirmPermanent(item)}
                    className="text-xs px-2.5 py-1 rounded bg-red-900/40 hover:bg-red-900/70 text-red-400 transition-colors"
                  >
                    Delete Forever
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Confirm permanent delete dialog */}
      {confirmPermanent && (
        <ConfirmDialog
          title="Delete Forever?"
          message={`"${confirmPermanent.title}" will be permanently deleted and cannot be recovered.`}
          confirmLabel="Delete Forever"
          confirmClassName="bg-red-600 hover:bg-red-700 text-white"
          onConfirm={() => handlePermanentDelete(confirmPermanent.id)}
          onCancel={() => setConfirmPermanent(null)}
        />
      )}

      {/* Confirm empty trash dialog */}
      {confirmEmptyAll && (
        <ConfirmDialog
          title="Empty Trash?"
          message={`All ${items.length} item${items.length !== 1 ? "s" : ""} will be permanently deleted and cannot be recovered.`}
          confirmLabel="Empty Trash"
          confirmClassName="bg-red-600 hover:bg-red-700 text-white"
          onConfirm={handleEmptyTrash}
          onCancel={() => setConfirmEmptyAll(false)}
        />
      )}
    </div>
  );
}

function ConfirmDialog({
  title,
  message,
  confirmLabel,
  confirmClassName,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  confirmClassName: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-gray-800 border border-gray-700 rounded-xl shadow-2xl p-5 max-w-sm w-full mx-4">
        <h3 className="text-sm font-semibold text-white mb-2">{title}</h3>
        <p className="text-xs text-gray-400 mb-5 leading-relaxed">{message}</p>
        <div className="flex gap-2 justify-end">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-xs rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-200 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className={`px-3 py-1.5 text-xs rounded-lg transition-colors ${confirmClassName}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function formatTrashedDate(iso: string | null): string {
  if (!iso) return "";
  try {
    const d = new Date(iso.replace(" ", "T") + "Z");
    return `Deleted ${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
  } catch {
    return "";
  }
}
