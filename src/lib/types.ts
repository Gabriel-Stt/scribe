export interface TranscriptSegment {
  text: string;
  start: number;
  end: number;
}

export interface Transcript {
  segments: TranscriptSegment[];
  full_text: string;
}

export interface StatusResponse {
  asr_ready: boolean;
  llm_ready: boolean;
  llm_error: string | null;
  recording_status: "idle" | "recording" | "paused";
}

export interface MeetingResult {
  meeting_id: string;
  summary: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface MeetingListItem {
  id: string;
  title: string;
  subject_tag: string | null;
  created_at: string;
  duration_seconds: number | null;
}

export interface NoteItem {
  id: string;
  elapsed_seconds: number;
  text: string;
}

export interface SummaryVersionItem {
  version: number;
  content: string;
  created_at: string;
}

export interface StoredChatMessage {
  role: string;
  content: string;
}

export interface MeetingDetail {
  id: string;
  title: string;
  subject_tag: string | null;
  created_at: string;
  duration_seconds: number | null;
  audio_path: string | null;
  segments: TranscriptSegment[];
  notes: NoteItem[];
  summaries: SummaryVersionItem[];
  chat_messages: StoredChatMessage[];
}

export const SUBJECT_TAGS = [
  "Chemistry",
  "History",
  "Business",
  "Portuguese",
  "MUN",
  "Math",
  "Physics",
  "Biology",
  "English",
  "Other",
];

export type AppView =
  | { kind: "home" }
  | { kind: "record" }
  | { kind: "meeting"; id: string }
  | { kind: "settings" };
