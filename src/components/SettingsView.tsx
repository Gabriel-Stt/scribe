import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { StatusResponse, UserTag } from "../lib/types";
import { StatusDot, Spinner } from "./shared";

const TAG_COLORS = [
  "#6366f1", "#8b5cf6", "#ec4899", "#ef4444",
  "#f97316", "#eab308", "#22c55e", "#14b8a6",
  "#3b82f6", "#6b7280",
];

export default function SettingsView() {
  const [contextText, setContextText] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Tags
  const [tags, setTags] = useState<UserTag[]>([]);
  const [newTagName, setNewTagName] = useState("");
  const [newTagColor, setNewTagColor] = useState(TAG_COLORS[0]);
  const [tagBusy, setTagBusy] = useState(false);

  useEffect(() => {
    invoke<string>("get_context")
      .then((c) => { setContextText(c); setLoading(false); })
      .catch(() => setLoading(false));
    invoke<StatusResponse>("get_status").then(setStatus).catch(() => {});
    loadTags();
  }, []);

  async function loadTags() {
    try {
      const t = await invoke<UserTag[]>("list_tags");
      setTags(t);
    } catch { /* ignore */ }
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      await invoke("save_context", { content: contextText });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleCreateTag() {
    if (!newTagName.trim()) return;
    setTagBusy(true);
    try {
      await invoke("create_tag", { args: { name: newTagName.trim(), color: newTagColor } });
      setNewTagName("");
      setNewTagColor(TAG_COLORS[0]);
      loadTags();
    } catch (e) {
      setError(String(e));
    } finally {
      setTagBusy(false);
    }
  }

  async function handleDeleteTag(id: string) {
    try {
      await invoke("delete_tag", { tagId: id });
      loadTags();
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-6 py-4 border-b border-gray-800">
        <h2 className="text-sm font-medium text-gray-300">Settings</h2>
      </div>

      <div className="flex-1 overflow-y-auto p-6 space-y-8 max-w-2xl">
        {error && (
          <div className="bg-red-900/50 border border-red-700 rounded-lg p-3 text-sm text-red-300 flex justify-between">
            <span>{error}</span>
            <button onClick={() => setError(null)} className="ml-3 shrink-0">✕</button>
          </div>
        )}

        {/* Engine status */}
        <section>
          <h3 className="text-xs text-gray-500 uppercase tracking-widest mb-3">Engine Status</h3>
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-3">
            <div className="flex items-center justify-between text-sm">
              <span className="text-gray-400">ASR (parakeet-mlx)</span>
              <StatusDot ok={status?.asr_ready ?? false} label={status?.asr_ready ? "Ready" : "Loading…"} />
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-gray-400">LLM (Ollama — qwen3.5:9b)</span>
              <StatusDot
                ok={status?.llm_ready ?? false}
                label={status?.llm_ready ? "Ready" : "Unavailable"}
                title={status?.llm_error ?? undefined}
              />
            </div>
            {status?.llm_error && (
              <p className="text-xs text-red-400 pt-1">{status.llm_error}</p>
            )}
          </div>
        </section>

        {/* Tags manager */}
        <section>
          <h3 className="text-xs text-gray-500 uppercase tracking-widest mb-3">Tags</h3>
          <p className="text-xs text-gray-600 mb-3">
            Create custom tags to label your recordings. Tags show up in the meeting header.
          </p>
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-3">
            {/* Existing tags */}
            {tags.length === 0 ? (
              <p className="text-xs text-gray-600 italic">No tags yet — create one below.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {tags.map((t) => (
                  <div key={t.id} className="flex items-center gap-1.5 rounded-full px-3 py-1" style={{ background: t.color + "33" }}>
                    <span className="text-xs font-medium" style={{ color: t.color }}>{t.name}</span>
                    <button
                      onClick={() => handleDeleteTag(t.id)}
                      className="text-gray-600 hover:text-red-400 transition-colors ml-0.5 text-xs leading-none"
                      title="Delete tag"
                    >✕</button>
                  </div>
                ))}
              </div>
            )}

            {/* New tag form */}
            <div className="pt-2 border-t border-gray-800 space-y-2">
              <div className="flex gap-2">
                <input
                  value={newTagName}
                  onChange={(e) => setNewTagName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleCreateTag()}
                  placeholder="New tag name…"
                  className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                />
                <button
                  onClick={handleCreateTag}
                  disabled={tagBusy || !newTagName.trim()}
                  className="btn-secondary text-xs px-3 disabled:opacity-40"
                >
                  {tagBusy ? <Spinner className="h-3 w-3" /> : "Add"}
                </button>
              </div>
              <div className="flex gap-1.5 flex-wrap">
                {TAG_COLORS.map((c) => (
                  <button
                    key={c}
                    onClick={() => setNewTagColor(c)}
                    className={`w-5 h-5 rounded-full transition-transform ${newTagColor === c ? "ring-2 ring-white scale-110" : ""}`}
                    style={{ background: c }}
                  />
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* Context file editor */}
        <section>
          <h3 className="text-xs text-gray-500 uppercase tracking-widest mb-1">
            Custom Summary Instructions
          </h3>
          <p className="text-xs text-gray-600 mb-3">
            These instructions are layered on top of the built-in default behavior. They can
            change format and tone but cannot disable factual-accuracy or gap-disclosure rules.
            See <code className="text-gray-500 bg-gray-800 px-1 rounded">docs/context.example.md</code> for examples.
          </p>
          {loading ? (
            <div className="flex items-center gap-2 text-gray-600 text-sm">
              <Spinner /> Loading…
            </div>
          ) : (
            <>
              <textarea
                value={contextText}
                onChange={(e) => { setContextText(e.target.value); setSaved(false); }}
                rows={12}
                className="w-full bg-gray-900 border border-gray-700 rounded-xl p-4 text-sm font-mono text-gray-200 placeholder-gray-700 focus:outline-none focus:ring-1 focus:ring-indigo-500 resize-y"
                placeholder={"<!-- Your custom instructions here -->\n\nFor Chemistry lectures: always pull out formulas into their own section.\n\nFor History: include a short chronological date list."}
              />
              <div className="flex items-center gap-3 mt-3">
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="btn-primary disabled:opacity-40"
                >
                  {saving ? <Spinner /> : saved ? "✓ Saved" : "Save"}
                </button>
                {saved && (
                  <span className="text-xs text-emerald-500">Changes will apply to the next summary.</span>
                )}
              </div>
            </>
          )}
        </section>

        {/* Privacy notice */}
        <section>
          <h3 className="text-xs text-gray-500 uppercase tracking-widest mb-3">Privacy</h3>
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 text-sm text-gray-500 space-y-1">
            <p>✓ All processing happens locally on your device.</p>
            <p>✓ Audio, transcripts, and summaries never leave your Mac.</p>
            <p>✓ No telemetry, no analytics, no network calls after initial model downloads.</p>
          </div>
        </section>
      </div>
    </div>
  );
}
