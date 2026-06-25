import { getOllamaHeaders } from "@/lib/ollama";
import { RAG_BACKEND as BACKEND } from "@/lib/constants";

export type AiHealthResult = {
  ok: boolean;
  status?: number;
  detail?: string;
};

export async function uploadPdf(
  file: File,
  userId: string,
  noteId: string,
  onProgress?: (msg: string) => void,
): Promise<{ text: string; chunks: number }> {
  onProgress?.("Uploading PDF…");
  const form = new FormData();
  form.append("file", file);

  const res = await fetch(
    `${BACKEND}/upload?user_id=${encodeURIComponent(userId)}&note_id=${encodeURIComponent(noteId)}`,
    { method: "POST", body: form, headers: getOllamaHeaders() },
  );

  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? "Upload failed");
  }

  return res.json();
}

export async function queryRag(
  question: string,
  noteId: string,
  userId: string,
  model?: string,
): Promise<{ answer: string; sources: string[] }> {
  const res = await fetch(`${BACKEND}/query`, {
    method:  "POST",
    headers: { "Content-Type": "application/json", ...getOllamaHeaders() },
    body:    JSON.stringify({ question, note_id: noteId, user_id: userId, model: model ?? "" }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? "Query failed");
  }

  return res.json();
}

export async function checkBackend(): Promise<AiHealthResult> {
  try {
    const res = await fetch(`${BACKEND}/ai-health`, {
      signal: AbortSignal.timeout(10000),
      headers: getOllamaHeaders(),
    });

    if (res.ok) {
      return { ok: true, status: res.status };
    }

    const raw = await res.text().catch(() => "");
    let detail = raw || `Request failed (${res.status})`;
    try {
      const parsed = raw ? JSON.parse(raw) as Record<string, unknown> : {};
      detail = typeof parsed.detail === "string"
        ? parsed.detail
        : typeof parsed.error === "string"
          ? parsed.error
          : detail;
    } catch {
      // Keep fallback detail.
    }

    return { ok: false, status: res.status, detail };
  } catch {
    return { ok: false, detail: "Network error while reaching backend health endpoint." };
  }
}