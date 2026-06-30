import { useRef, useCallback, useState, useEffect } from "react";

const TEXT_COLORS = [
  { label: "Red",      color: "#ef4444" },
  { label: "Orange",   color: "#f97316" },
  { label: "Yellow",   color: "#eab308" },
  { label: "Green",    color: "#22c55e" },
  { label: "Cyan",     color: "#06b6d4" },
  { label: "Blue",     color: "#3b82f6" },
  { label: "Purple",   color: "#8b5cf6" },
  { label: "Pink",     color: "#ec4899" },
  { label: "White",    color: "#f9fafb" },
  { label: "Gray",     color: "#9ca3af" },
  { label: "Brown",    color: "#a16207" },
  { label: "Dark",     color: "#374151" },
];

const HIGHLIGHT_COLORS = [
  { label: "Yellow",   color: "#fef08a" },
  { label: "Green",    color: "#bbf7d0" },
  { label: "Blue",     color: "#bfdbfe" },
  { label: "Pink",     color: "#fbcfe8" },
  { label: "Orange",   color: "#fed7aa" },
  { label: "Purple",   color: "#e9d5ff" },
  { label: "Red",      color: "#fecaca" },
  { label: "Cyan",     color: "#a5f3fc" },
  { label: "Lime",     color: "#d9f99d" },
];

interface Props {
  initialContent: string | null;
  onSave: (html: string) => Promise<void>;
}

function Divider() {
  return <span className="w-px h-4 bg-gray-700 mx-1 shrink-0" />;
}

function ToolBtn({
  onClick,
  active = false,
  title,
  children,
  disabled = false,
}: {
  onClick: () => void;
  active?: boolean;
  title: string;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onMouseDown={(e) => { e.preventDefault(); onClick(); }}
      title={title}
      disabled={disabled}
      className={`px-1.5 py-1 rounded text-xs font-medium transition-colors shrink-0 ${
        active
          ? "bg-indigo-600 text-white"
          : "text-gray-400 hover:bg-gray-700 hover:text-gray-200"
      } disabled:opacity-30 disabled:cursor-not-allowed`}
    >
      {children}
    </button>
  );
}

export default function NoteEditor({ initialContent, onSave }: Props) {
  const editorRef = useRef<HTMLDivElement>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved">("idle");
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [showHighlightPicker, setShowHighlightPicker] = useState(false);
  const colorPickerRef = useRef<HTMLDivElement>(null);
  const highlightPickerRef = useRef<HTMLDivElement>(null);
  // Ticks on every selection change so toolbar buttons re-evaluate active state
  const [, setTick] = useState(0);

  // Load content once on mount (key prop handles note switching)
  useEffect(() => {
    if (editorRef.current) {
      editorRef.current.innerHTML = initialContent || "";
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-render toolbar on every selection change
  useEffect(() => {
    const handler = () => setTick((n) => n + 1);
    document.addEventListener("selectionchange", handler);
    return () => document.removeEventListener("selectionchange", handler);
  }, []);

  // Close color pickers on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (colorPickerRef.current && !colorPickerRef.current.contains(e.target as Node))
        setShowColorPicker(false);
      if (highlightPickerRef.current && !highlightPickerRef.current.contains(e.target as Node))
        setShowHighlightPicker(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const doSave = useCallback(async (html: string) => {
    setSaveStatus("saving");
    try {
      await onSave(html);
      setSaveStatus("saved");
      setTimeout(() => setSaveStatus("idle"), 1500);
    } catch {
      setSaveStatus("idle");
    }
  }, [onSave]);

  function scheduleSave() {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      doSave(editorRef.current?.innerHTML ?? "");
    }, 800);
  }

  function exec(command: string, value?: string) {
    editorRef.current?.focus();
    document.execCommand(command, false, value ?? "");
    setTick((n) => n + 1);
    scheduleSave();
  }

  function isCmd(command: string): boolean {
    try { return document.queryCommandState(command); } catch { return false; }
  }

  function blockTag(): string {
    try { return document.queryCommandValue("formatBlock").toLowerCase(); } catch { return ""; }
  }

  const block = blockTag();

  return (
    <div className="flex flex-col h-full">
      {/* ── Toolbar ── */}
      <div className="flex items-center gap-0.5 flex-wrap px-3 py-2 border-b border-gray-800 bg-gray-900/60 sticky top-0 z-10">

        {/* Undo / Redo */}
        <ToolBtn onClick={() => exec("undo")} title="Undo (⌘Z)">↩</ToolBtn>
        <ToolBtn onClick={() => exec("redo")} title="Redo (⌘⇧Z)">↪</ToolBtn>

        <Divider />

        {/* Inline formatting */}
        <ToolBtn onClick={() => exec("bold")}          active={isCmd("bold")}          title="Bold (⌘B)"><strong>B</strong></ToolBtn>
        <ToolBtn onClick={() => exec("italic")}        active={isCmd("italic")}        title="Italic (⌘I)"><em>I</em></ToolBtn>
        <ToolBtn onClick={() => exec("underline")}     active={isCmd("underline")}     title="Underline (⌘U)"><span className="underline">U</span></ToolBtn>
        <ToolBtn onClick={() => exec("strikeThrough")} active={isCmd("strikeThrough")} title="Strikethrough"><span className="line-through">S</span></ToolBtn>

        <Divider />

        {/* Block / size */}
        <ToolBtn onClick={() => exec("formatBlock", "h1")} active={block === "h1"} title="Heading 1 (large)">H1</ToolBtn>
        <ToolBtn onClick={() => exec("formatBlock", "h2")} active={block === "h2"} title="Heading 2 (medium)">H2</ToolBtn>
        <ToolBtn onClick={() => exec("formatBlock", "h3")} active={block === "h3"} title="Heading 3 (small)">H3</ToolBtn>
        <ToolBtn onClick={() => exec("formatBlock", "p")}  active={block === "p" || block === ""} title="Paragraph (normal)">¶</ToolBtn>

        <Divider />

        {/* Lists & block elements */}
        <ToolBtn onClick={() => exec("insertUnorderedList")} active={isCmd("insertUnorderedList")} title="Bullet list">•≡</ToolBtn>
        <ToolBtn onClick={() => exec("insertOrderedList")}   active={isCmd("insertOrderedList")}   title="Ordered list">1≡</ToolBtn>
        <ToolBtn onClick={() => exec("formatBlock", "blockquote")} active={block === "blockquote"} title="Blockquote">❝</ToolBtn>

        <Divider />

        {/* Text color */}
        <div className="relative" ref={colorPickerRef}>
          <button
            type="button"
            onMouseDown={(e) => { e.preventDefault(); setShowColorPicker((v) => !v); setShowHighlightPicker(false); }}
            title="Text color"
            className="px-1.5 py-1 rounded text-xs text-gray-400 hover:bg-gray-700 hover:text-gray-200 transition-colors flex flex-col items-center"
          >
            <span className="font-bold text-sm leading-none text-gray-200">A</span>
            <span className="block h-1 w-3.5 rounded-sm mt-0.5" style={{ background: "linear-gradient(90deg,#ef4444,#3b82f6,#22c55e)" }} />
          </button>
          {showColorPicker && (
            <div className="absolute top-full left-0 mt-1 z-30 bg-gray-900 border border-gray-700 rounded-xl shadow-2xl p-3 w-[168px]">
              <p className="text-[10px] font-medium text-gray-400 uppercase tracking-widest mb-2">Text color</p>
              <div className="grid grid-cols-4 gap-1.5 mb-2">
                {TEXT_COLORS.map(({ label, color }) => (
                  <button
                    key={label}
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      exec("foreColor", color);
                      setShowColorPicker(false);
                    }}
                    title={label}
                    className="w-8 h-8 rounded-lg border-2 border-transparent hover:border-white/40 hover:scale-110 transition-all"
                    style={{ background: color }}
                  />
                ))}
              </div>
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  exec("foreColor", "#e5e7eb");
                  setShowColorPicker(false);
                }}
                className="w-full text-[10px] text-gray-500 hover:text-gray-300 hover:bg-gray-800 rounded px-2 py-1 text-left transition-colors"
              >
                ↩ Reset to default
              </button>
            </div>
          )}
        </div>

        {/* Highlight color */}
        <div className="relative" ref={highlightPickerRef}>
          <button
            type="button"
            onMouseDown={(e) => { e.preventDefault(); setShowHighlightPicker((v) => !v); setShowColorPicker(false); }}
            title="Highlight color"
            className="px-1.5 py-1 rounded text-xs text-gray-400 hover:bg-gray-700 hover:text-gray-200 transition-colors flex flex-col items-center"
          >
            <span className="font-bold text-sm leading-none" style={{ background: "#fef08a", color: "#1a1a1a", padding: "0 2px", borderRadius: 2 }}>H</span>
            <span className="block h-1 w-3.5 rounded-sm mt-0.5" style={{ background: "linear-gradient(90deg,#fef08a,#bbf7d0,#bfdbfe)" }} />
          </button>
          {showHighlightPicker && (
            <div className="absolute top-full left-0 mt-1 z-30 bg-gray-900 border border-gray-700 rounded-xl shadow-2xl p-3 w-[168px]">
              <p className="text-[10px] font-medium text-gray-400 uppercase tracking-widest mb-2">Highlight</p>
              <div className="grid grid-cols-3 gap-1.5 mb-2">
                {HIGHLIGHT_COLORS.map(({ label, color }) => (
                  <button
                    key={label}
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      exec("backColor", color);
                      setShowHighlightPicker(false);
                    }}
                    title={label}
                    className="w-full h-8 rounded-lg border-2 border-transparent hover:border-white/40 hover:scale-105 transition-all flex items-center justify-center text-[10px] font-medium"
                    style={{ background: color, color: "#1a1a1a" }}
                  >
                    {label.slice(0, 3)}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  exec("backColor", "transparent");
                  setShowHighlightPicker(false);
                }}
                className="w-full text-[10px] text-gray-500 hover:text-gray-300 hover:bg-gray-800 rounded px-2 py-1 text-left transition-colors"
              >
                ✕ Remove highlight
              </button>
            </div>
          )}
        </div>

        {/* Save indicator */}
        <div className="ml-auto text-[10px] shrink-0">
          {saveStatus === "saving" && <span className="text-gray-500">Saving…</span>}
          {saveStatus === "saved"  && <span className="text-emerald-500">Saved</span>}
        </div>
      </div>

      {/* ── Editor area ── */}
      <div
        className="flex-1 overflow-y-auto px-6 py-4 cursor-text"
        onClick={() => editorRef.current?.focus()}
      >
        <div
          ref={editorRef}
          contentEditable
          suppressContentEditableWarning
          onInput={scheduleSave}
          data-placeholder="Start writing your notes here…"
          className="note-editor-content focus:outline-none"
        />
      </div>
    </div>
  );
}
