import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function Spinner({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg
      className={`animate-spin text-gray-400 ${className}`}
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8v8H4z"
      />
    </svg>
  );
}

export function StatusDot({
  ok,
  label,
  title,
}: {
  ok: boolean;
  label: string;
  title?: string;
}) {
  return (
    <span title={title} className={`flex items-center gap-1.5 ${title ? "cursor-help" : ""}`}>
      <span
        className={`w-2 h-2 rounded-full ${ok ? "bg-emerald-400" : "bg-amber-400 animate-pulse"}`}
      />
      <span className={ok ? "text-gray-500" : "text-amber-400"}>{label}</span>
    </span>
  );
}

export function MarkdownBody({ children }: { children: string }) {
  return (
    <div className="md-body text-sm text-gray-300">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}

export function SubjectPill({ tag }: { tag: string | null }) {
  if (!tag) return null;
  const colors: Record<string, string> = {
    Chemistry: "bg-emerald-900/60 text-emerald-300",
    History: "bg-amber-900/60 text-amber-300",
    Business: "bg-blue-900/60 text-blue-300",
    Portuguese: "bg-purple-900/60 text-purple-300",
    MUN: "bg-indigo-900/60 text-indigo-300",
    Math: "bg-cyan-900/60 text-cyan-300",
    Physics: "bg-orange-900/60 text-orange-300",
    Biology: "bg-lime-900/60 text-lime-300",
    English: "bg-pink-900/60 text-pink-300",
  };
  const cls = colors[tag] ?? "bg-gray-700 text-gray-300";
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${cls}`}>{tag}</span>
  );
}
