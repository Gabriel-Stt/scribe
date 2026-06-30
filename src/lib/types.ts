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

export interface Folder {
  id: string;
  name: string;
  color: string;
  created_at: string;
}

export interface UserTag {
  id: string;
  name: string;
  color: string;
}

export interface MeetingListItem {
  id: string;
  title: string;
  folder_id: string | null;
  created_at: string;
  duration_seconds: number | null;
  is_pinned: boolean;
  deleted_at: string | null;
  tags: UserTag[];
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

export interface ActionItem {
  text: string;
  done: boolean;
}

export interface LinkedMeeting {
  id: string;
  title: string;
  created_at: string;
}

export interface MeetingDetail {
  id: string;
  title: string;
  folder_id: string | null;
  created_at: string;
  duration_seconds: number | null;
  audio_path: string | null;
  active_summary_version: number | null;
  is_pinned: boolean;
  segments: TranscriptSegment[];
  notes: NoteItem[];
  summaries: SummaryVersionItem[];
  chat_messages: StoredChatMessage[];
  tags: UserTag[];
  notes_content: string | null;
  action_items: ActionItem[];
  linked_notes: NoteFile[];
}

export interface AppSettings {
  auto_delete_audio: boolean;
  recordings_dir: string | null;
  selected_device: string | null;
  sort_by: string;
  default_tag: string | null;
}

export interface NoteFile {
  id: string;
  title: string;
  content: string;
  folder_id: string | null;
  created_at: string;
  updated_at: string;
}

export type AppView =
  | { kind: "home" }
  | { kind: "record" }
  | { kind: "meeting"; id: string }
  | { kind: "note"; id: string }
  | { kind: "settings" }
  | { kind: "trash" };
