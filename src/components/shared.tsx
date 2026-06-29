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
