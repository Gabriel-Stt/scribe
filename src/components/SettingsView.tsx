import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { StatusResponse } from "../lib/types";
import { StatusDot, Spinner } from "./shared";

export default function SettingsView() {
  const [contextText, setContextText] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke<string>("get_context")
      .then((c) => { setContextText(c); setLoading(false); })
      .catch(() => setLoading(false));
    invoke<StatusResponse>("get_status").then(setStatus).catch(() => {});
  }, []);

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

  return (
    <div className="flex flex-col h-full">
      <div className="px-6 py-4 border-b border-gray-800">
        <h2 className="text-sm font-medium text-gray-300">Settings</h2>
      </div>

      <div className="flex-1 overflow-y-auto p-6 space-y-8 max-w-2xl">
        {error && (
          <div className="bg-red-900/50 border border-red-700 rounded-lg p-3 text-sm text-red-300">
            {error}
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
