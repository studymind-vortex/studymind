import { supabase } from "@/integrations/supabase/client";
import { getOllamaHeaders } from "@/lib/ollama";
import { RAG_BACKEND } from "@/lib/constants";

type JsonRecord = Record<string, unknown>;

const BASE = import.meta.env.VITE_SUPABASE_URL as string;
const ANON = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string;

async function authHeader() {
  const { data: { session } } = await supabase.auth.getSession();
  return { Authorization: `Bearer ${session?.access_token ?? ANON}`, apikey: ANON };
}

export async function streamChat({
  messages,
  noteContext,
  noteId,
  userId,
  onDelta,
  onDone,
  onError,
  signal,
}: {
  messages: { role: "user" | "assistant"; content: string }[];
  noteContext?: string;
  noteId?: string;
  userId: string;
  onDelta: (chunk: string) => void;
  onDone: () => void;
  onError: (msg: string) => void;
  signal?: AbortSignal;
}) {
  try {
    const userMessage = messages[messages.length - 1];
    if (!userMessage || userMessage.role !== "user") {
      onError("No user message to process");
      return;
    }

    const prompt = noteContext
      ? `${userMessage.content}\n\n(Context from your notes: ${String(noteContext).slice(0, 5000)})`
      : userMessage.content;

    const resp = await fetch(`${RAG_BACKEND}/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...getOllamaHeaders() },
      body: JSON.stringify({
        question: prompt,
        note_id: noteId ?? "",
        user_id: userId,
      }),
      signal,
    });

    if (!resp.ok) {
      const j = await resp.json().catch(() => ({}));
      onError(j.error || `Chat failed (${resp.status})`);
      return;
    }

    const { answer } = await resp.json();
    if (answer) {
      onDelta(answer);
    }
    onDone();
  } catch (error: unknown) {
    if (error instanceof DOMException && error.name === "AbortError") return;
    onError(error instanceof Error ? error.message : "Network error");
  }
}

export async function ttsToBlob(text: string, voice = "default", signal?: AbortSignal, speed = 1): Promise<Blob> {
  const resp = await fetch(`${RAG_BACKEND}/tts-generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...getOllamaHeaders() },
    body: JSON.stringify({ text, voice, speed }),
    signal,
  });
  if (!resp.ok) {
    const raw = await resp.text().catch(() => "");
    let parsed: JsonRecord = {};
    try {
      parsed = raw ? (JSON.parse(raw) as JsonRecord) : {};
    } catch {
      parsed = {};
    }
    const message = typeof parsed.detail === "string"
      ? parsed.detail
      : typeof parsed.error === "string"
        ? parsed.error
        : raw || `TTS failed (${resp.status})`;
    throw new Error(String(message));
  }
  return resp.blob();
}

export async function transcribeAudio(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  const base64 = btoa(bin);
  const { data, error } = await supabase.functions.invoke("stt", {
    body: { audio: base64, mimeType: blob.type || "audio/webm" },
  });
  if (error) throw new Error(error.message);
  return typeof data === "object" && data !== null && "text" in data && typeof (data as { text?: unknown }).text === "string"
    ? (data as { text: string }).text
    : "";
}

export async function generateQuiz(content: string, count = 5, difficulty: "easy" | "medium" | "hard" = "medium") {
  const resp = await fetch(`${RAG_BACKEND}/quiz-generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...getOllamaHeaders() },
    body: JSON.stringify({ content, count, difficulty }),
  });
  if (!resp.ok) {
    const j = await resp.json().catch(() => ({}));
    throw new Error(j.detail || j.error || `Quiz generation failed (${resp.status})`);
  }
  return await resp.json() as {
    title: string;
    questions: { question: string; options: string[]; correctIndex: number; explanation: string }[];
  };
}

export async function generateFlashcards(content: string, count = 10) {
  const resp = await fetch(`${RAG_BACKEND}/flashcards-generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...getOllamaHeaders() },
    body: JSON.stringify({ content, count }),
  });
  if (!resp.ok) {
    const j = await resp.json().catch(() => ({}));
    throw new Error(j.detail || j.error || `Flashcard generation failed (${resp.status})`);
  }
  return await resp.json() as { title: string; cards: { front: string; back: string }[] };
}

export async function summarizeNote(content: string, maxPoints = 8, mode: "standard" | "eli5" = "standard") {
  const resp = await fetch(`${RAG_BACKEND}/summarize-note`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...getOllamaHeaders() },
    body: JSON.stringify({ content, max_points: maxPoints, mode }),
  });
  if (!resp.ok) {
    const raw = await resp.text().catch(() => "");
    let parsed: JsonRecord = {};
    try {
      parsed = raw ? (JSON.parse(raw) as JsonRecord) : {};
    } catch {
      parsed = {};
    }
    const message = typeof parsed.detail === "string"
      ? parsed.detail
      : typeof parsed.error === "string"
        ? parsed.error
        : raw || `Summarization failed (${resp.status})`;
    throw new Error(message);
  }
  return await resp.json() as {
    mode: "standard" | "eli5";
    title: string;
    summary: string;
    analogy: string;
    bullets: string[];
    key_terms: string[];
    visual_flow: { label: string; note: string }[];
  };
}

export async function deleteCurrentAccount() {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;

  if (!token) {
    throw new Error("No active session found.");
  }

  const resp = await fetch(`${RAG_BACKEND}/account`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!resp.ok) {
    const raw = await resp.text().catch(() => "");
    let parsed: JsonRecord = {};
    try {
      parsed = raw ? (JSON.parse(raw) as JsonRecord) : {};
    } catch {
      parsed = {};
    }
    const message = typeof parsed.detail === "string"
      ? parsed.detail
      : raw || `Account deletion failed (${resp.status})`;
    throw new Error(message);
  }
}
