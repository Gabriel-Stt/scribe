import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AppView, MeetingListItem } from "../lib/types";
import {
  ChatSession,
  loadChatSessions,
  saveChatSession,
  genChatId,
} from "../lib/chatStorage";

interface ChatViewProps {
  sessionId: string | null;
  onNavigate: (view: AppView) => void;
}

function makeEmptySession(): ChatSession {
  const now = new Date().toISOString();
  return {
    id: genChatId(),
    title: "New Chat",
    contextMeetingIds: [],
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <button
      onClick={handleCopy}
      title="Copy message"
      className="opacity-0 group-hover:opacity-100 transition-opacity shrink-0 p-1.5 rounded-lg text-gray-600 hover:text-gray-300 hover:bg-gray-800"
    >
      {copied ? (
        <svg className="w-3.5 h-3.5 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
        </svg>
      ) : (
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
            d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
        </svg>
      )}
    </button>
  );
}

function MdContent({ children }: { children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: ({ children }) => <p className="mb-2 last:mb-0 break-words">{children}</p>,
        ul: ({ children }) => <ul className="list-disc list-inside mb-2 space-y-0.5">{children}</ul>,
        ol: ({ children }) => <ol className="list-decimal list-inside mb-2 space-y-0.5">{children}</ol>,
        li: ({ children }) => <li className="break-words">{children}</li>,
        strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
        em: ({ children }) => <em className="italic">{children}</em>,
        code: ({ children, className }) =>
          className ? (
            <pre className="bg-gray-900 rounded-lg px-3 py-2 text-xs my-2 overflow-x-auto">
              <code>{children}</code>
            </pre>
          ) : (
            <code className="bg-gray-900 rounded px-1 py-0.5 text-xs font-mono">{children}</code>
          ),
        h1: ({ children }) => <h1 className="font-bold text-base mb-1 mt-2">{children}</h1>,
        h2: ({ children }) => <h2 className="font-semibold mb-1 mt-2">{children}</h2>,
        h3: ({ children }) => <h3 className="font-medium mb-1 mt-1.5">{children}</h3>,
        blockquote: ({ children }) => (
          <blockquote className="border-l-2 border-gray-600 pl-3 text-gray-400 my-1">{children}</blockquote>
        ),
        hr: () => <hr className="border-gray-700 my-2" />,
      }}
    >
      {children}
    </ReactMarkdown>
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

export default function ChatView({ sessionId, onNavigate }: ChatViewProps) {
  const [session, setSession] = useState<ChatSession>(makeEmptySession);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [streaming, setStreaming] = useState<string | null>(null);
  const [showPicker, setShowPicker] = useState(false);
  const [pickerSearch, setPickerSearch] = useState("");
  const [allMeetings, setAllMeetings] = useState<MeetingListItem[]>([]);
  const endRef = useRef<HTMLDivElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Load or reset session when sessionId changes
  useEffect(() => {
    if (sessionId === null) {
      setSession(makeEmptySession());
    } else {
      const found = loadChatSessions().find((s) => s.id === sessionId);
      setSession(found ?? makeEmptySession());
    }
    setInput("");
    setStreaming(null);
    setShowPicker(false);
  }, [sessionId]);

  // Load meetings for the context picker
  useEffect(() => {
    invoke<MeetingListItem[]>("list_meetings", {
      search: null,
      folderId: null,
      sortBy: "date_desc",
    })
      .then(setAllMeetings)
      .catch(() => {});
  }, []);

  // Auto-scroll on new messages / streaming
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [session.messages, streaming]);

  // Close picker on outside click
  useEffect(() => {
    if (!showPicker) return;
    const h = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setShowPicker(false);
      }
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [showPicker]);

  function toggleMeeting(id: string) {
    const newIds = session.contextMeetingIds.includes(id)
      ? session.contextMeetingIds.filter((x) => x !== id)
      : [...session.contextMeetingIds, id];
    const updated = { ...session, contextMeetingIds: newIds };
    setSession(updated);
    // Persist only if the session already exists in storage
    if (sessionId !== null) saveChatSession(updated);
  }

  async function handleSend() {
    if (!input.trim() || busy) return;
    const msg = input.trim();
    setInput("");
    // Reset textarea height
    if (textareaRef.current) textareaRef.current.style.height = "auto";

    const isNew = sessionId === null;
    const currentSession: ChatSession = isNew
      ? { ...session, title: msg.slice(0, 60) }
      : session;

    const userMessages = [
      ...currentSession.messages,
      { role: "user" as const, content: msg },
    ];
    const withUser: ChatSession = {
      ...currentSession,
      messages: userMessages,
      updatedAt: new Date().toISOString(),
    };
    setSession(withUser);
    saveChatSession(withUser);

    if (isNew) {
      onNavigate({ kind: "chat", sessionId: currentSession.id });
    }

    setStreaming("");
    setBusy(true);

    const unlisten = await listen<string>("standalone-chat-chunk", (e) => {
      setStreaming((prev) => (prev ?? "") + e.payload);
    });

    try {
      const resp = await invoke<{ response: string }>("send_standalone_chat", {
        args: {
          message: msg,
          meeting_ids: currentSession.contextMeetingIds,
          history: currentSession.messages,
        },
      });
      const withResponse: ChatSession = {
        ...withUser,
        messages: [
          ...userMessages,
          { role: "assistant" as const, content: resp.response },
        ],
        updatedAt: new Date().toISOString(),
      };
      setSession(withResponse);
      saveChatSession(withResponse);
    } catch {
      // Leave the user message visible; streaming stops naturally
    } finally {
      unlisten();
      setStreaming(null);
      setBusy(false);
    }
  }

  const contextMeetings = allMeetings.filter((m) =>
    session.contextMeetingIds.includes(m.id)
  );
  const pickerFiltered = allMeetings.filter(
    (m) =>
      pickerSearch === "" ||
      m.title.toLowerCase().includes(pickerSearch.toLowerCase())
  );

  return (
    <div className="flex-1 flex flex-col h-full min-h-0 bg-gray-950">
      {/* Context bar */}
      <div className="shrink-0 px-6 py-3 border-b border-gray-800 flex items-center gap-2 flex-wrap min-h-[52px]">
        {contextMeetings.map((m) => (
          <span
            key={m.id}
            className="flex items-center gap-1 bg-indigo-600/20 border border-indigo-600/40 text-indigo-300 text-xs pl-2.5 pr-1.5 py-1 rounded-full"
          >
            <button
              onClick={() => {
                saveChatSession(session);
                onNavigate({
                  kind: "split",
                  left: { kind: "chat", sessionId: session.id },
                  right: { kind: "meeting", id: m.id },
                });
              }}
              title="Open in split view"
              className="truncate max-w-[160px] hover:text-white transition-colors text-left"
            >
              {m.title}
            </button>
            <span className="text-indigo-700 mx-0.5">·</span>
            <button
              onClick={() => toggleMeeting(m.id)}
              className="text-indigo-500 hover:text-indigo-200 leading-none shrink-0"
            >
              ✕
            </button>
          </span>
        ))}

        {/* Picker trigger */}
        <div className="relative" ref={pickerRef}>
          <button
            onClick={() => {
              setShowPicker((v) => !v);
              setPickerSearch("");
            }}
            className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-300 border border-dashed border-gray-700 hover:border-gray-600 px-2.5 py-1 rounded-full transition-colors"
          >
            <svg
              className="w-3 h-3"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 4v16m8-8H4"
              />
            </svg>
            Add meeting context
          </button>

          {showPicker && (
            <div className="absolute top-full left-0 mt-1.5 w-80 bg-gray-800 border border-gray-700 rounded-xl shadow-2xl z-50 overflow-hidden">
              <div className="p-2 border-b border-gray-700">
                <input
                  autoFocus
                  value={pickerSearch}
                  onChange={(e) => setPickerSearch(e.target.value)}
                  placeholder="Search meetings…"
                  className="w-full bg-gray-700 rounded-lg px-3 py-1.5 text-xs text-gray-200 placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                />
              </div>
              <div className="max-h-60 overflow-y-auto py-1">
                {pickerFiltered.length === 0 && (
                  <p className="px-3 py-4 text-xs text-gray-600 text-center">
                    No meetings found
                  </p>
                )}
                {pickerFiltered.map((m) => {
                  const selected = session.contextMeetingIds.includes(m.id);
                  return (
                    <button
                      key={m.id}
                      onClick={() => toggleMeeting(m.id)}
                      className="w-full flex items-center gap-2.5 px-3 py-2 text-left text-xs hover:bg-gray-700 transition-colors"
                    >
                      <span
                        className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 text-[9px] font-bold text-white transition-colors ${
                          selected
                            ? "bg-indigo-600 border-indigo-600"
                            : "border-gray-600"
                        }`}
                      >
                        {selected ? "✓" : ""}
                      </span>
                      <span className="flex-1 text-gray-200 truncate">
                        {m.title}
                      </span>
                      <span className="text-gray-600 shrink-0 text-[10px]">
                        {formatDate(m.created_at)}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {contextMeetings.length === 0 && (
          <span className="text-xs text-gray-700 italic">
            No meeting context — general assistant
          </span>
        )}
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto min-h-0 px-6 py-6 space-y-4">
        {session.messages.length === 0 && streaming === null && (
          <div className="flex flex-col items-center justify-center h-full gap-4 text-center">
            <div className="w-12 h-12 rounded-full bg-indigo-600/15 flex items-center justify-center">
              <svg
                className="w-5 h-5 text-indigo-400"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.8}
                  d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
                />
              </svg>
            </div>
            <div>
              <p className="text-sm font-medium text-gray-300 mb-1">
                {contextMeetings.length > 0
                  ? `${contextMeetings.length} meeting${contextMeetings.length > 1 ? "s" : ""} loaded as context`
                  : "Ask me anything"}
              </p>
              <p className="text-xs text-gray-600 max-w-xs leading-relaxed">
                {contextMeetings.length > 0
                  ? "Ask questions about the selected meetings, or anything else."
                  : "Add meeting context above to discuss specific recordings."}
              </p>
            </div>
          </div>
        )}

        {session.messages.map((msg, i) => (
          <div
            key={i}
            className={`group flex items-end gap-2 ${msg.role === "user" ? "justify-end" : "justify-start"}`}
          >
            {/* Copy sits left of user bubble, right of assistant bubble */}
            {msg.role === "user" && <CopyButton text={msg.content} />}
            <div
              className={`max-w-[75%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                msg.role === "user"
                  ? "bg-indigo-600 text-white rounded-br-sm"
                  : "bg-gray-800 text-gray-200 rounded-bl-sm"
              }`}
            >
              {msg.role === "user" ? (
                <p className="whitespace-pre-wrap break-words">{msg.content}</p>
              ) : (
                <MdContent>{msg.content}</MdContent>
              )}
            </div>
            {msg.role === "assistant" && <CopyButton text={msg.content} />}
          </div>
        ))}

        {streaming !== null && (
          <div className="flex justify-start">
            <div className="max-w-[75%] bg-gray-800 text-gray-200 rounded-2xl rounded-bl-sm px-4 py-3 text-sm leading-relaxed">
              {streaming ? (
                <MdContent>{streaming}</MdContent>
              ) : (
                <span className="flex gap-1 items-center h-5">
                  <span
                    className="w-1.5 h-1.5 bg-gray-500 rounded-full animate-bounce"
                    style={{ animationDelay: "0ms" }}
                  />
                  <span
                    className="w-1.5 h-1.5 bg-gray-500 rounded-full animate-bounce"
                    style={{ animationDelay: "150ms" }}
                  />
                  <span
                    className="w-1.5 h-1.5 bg-gray-500 rounded-full animate-bounce"
                    style={{ animationDelay: "300ms" }}
                  />
                </span>
              )}
            </div>
          </div>
        )}

        <div ref={endRef} />
      </div>

      {/* Input */}
      <div className="shrink-0 px-6 py-4 border-t border-gray-800">
        <div className="flex gap-3 items-end">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            onInput={(e) => {
              const el = e.currentTarget;
              el.style.height = "auto";
              el.style.height = Math.min(el.scrollHeight, 140) + "px";
            }}
            placeholder={busy ? "Thinking…" : "Ask anything… (Shift+Enter for new line)"}
            disabled={busy}
            rows={1}
            className="flex-1 bg-gray-800 border border-gray-700 rounded-xl px-4 py-2.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-indigo-500 resize-none disabled:opacity-50"
            style={{ minHeight: "42px", maxHeight: "140px" }}
          />
          <button
            onClick={handleSend}
            disabled={busy || !input.trim()}
            className="shrink-0 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 text-white rounded-xl px-4 py-2.5 text-sm font-medium transition-colors"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
