export interface ChatSession {
  id: string;
  title: string;
  contextMeetingIds: string[];
  messages: { role: "user" | "assistant"; content: string }[];
  createdAt: string;
  updatedAt: string;
}

const STORAGE_KEY = "scribe:chat-sessions";

export function loadChatSessions(): ChatSession[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
  } catch {
    return [];
  }
}

export function saveChatSession(session: ChatSession): void {
  const rest = loadChatSessions().filter((s) => s.id !== session.id);
  localStorage.setItem(STORAGE_KEY, JSON.stringify([session, ...rest]));
  window.dispatchEvent(new Event("scribe:reload-chats"));
}

export function deleteChatSession(id: string): void {
  const rest = loadChatSessions().filter((s) => s.id !== id);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(rest));
  window.dispatchEvent(new Event("scribe:reload-chats"));
}

export function genChatId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
