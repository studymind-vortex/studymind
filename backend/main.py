from fastapi import FastAPI, UploadFile, File, HTTPException, Query, Response, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import fitz  # PyMuPDF
import httpx
import os
import json
import re
import tempfile
from urllib.parse import urlparse
from pathlib import Path
import shutil
from functools import lru_cache
from supabase import create_client
from dotenv import load_dotenv

load_dotenv(Path(__file__).with_name(".env"))

app = FastAPI(title="StudyMind RAG Backend")

_FRONTEND_URL = os.getenv("FRONTEND_URL", "")
_CORS_ORIGINS = [
    "http://localhost:5173",
    "http://localhost:3000",
]
if _FRONTEND_URL:
    _CORS_ORIGINS.append(_FRONTEND_URL)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_CORS_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)

SUPABASE_URL      = os.getenv("SUPABASE_URL")
SUPABASE_KEY      = os.getenv("SUPABASE_SERVICE_KEY")   # service-role key (bypasses RLS)
OLLAMA_URL        = os.getenv("OLLAMA_URL", "http://localhost:11434")
LEGACY_EMBED_MODEL = os.getenv("EMBED_MODEL")
LEGACY_CHAT_MODEL = os.getenv("CHAT_MODEL")
LEGACY_QUIZ_MODEL = os.getenv("QUIZ_MODEL")
LEGACY_FLASHCARD_MODEL = os.getenv("FLASHCARD_MODEL")

LOCAL_EMBED_MODEL = os.getenv("LOCAL_EMBED_MODEL", LEGACY_EMBED_MODEL or "nomic-embed-text")
API_EMBED_MODEL = os.getenv("API_EMBED_MODEL", LEGACY_EMBED_MODEL or "text-embedding-3-small")

LOCAL_CHAT_MODEL = os.getenv("LOCAL_CHAT_MODEL", LEGACY_CHAT_MODEL or "llama3.2")
API_CHAT_MODEL = os.getenv("API_CHAT_MODEL", LEGACY_CHAT_MODEL or "openai/gpt-4o-mini")

LOCAL_QUIZ_MODEL = os.getenv("LOCAL_QUIZ_MODEL", LEGACY_QUIZ_MODEL or LOCAL_CHAT_MODEL)
API_QUIZ_MODEL = os.getenv("API_QUIZ_MODEL", LEGACY_QUIZ_MODEL or API_CHAT_MODEL)

LOCAL_FLASHCARD_MODEL = os.getenv("LOCAL_FLASHCARD_MODEL", LEGACY_FLASHCARD_MODEL or LOCAL_CHAT_MODEL)
API_FLASHCARD_MODEL = os.getenv("API_FLASHCARD_MODEL", LEGACY_FLASHCARD_MODEL or API_CHAT_MODEL)
TTS_MAX_CHARS     = int(os.getenv("TTS_MAX_CHARS", "12000"))
TTS_ENGINE        = os.getenv("TTS_ENGINE", "espeak-ng")
TTS_VOICE         = os.getenv("TTS_VOICE", "en-us")
TTS_DEFAULT_SPEED  = float(os.getenv("TTS_DEFAULT_SPEED", "1.0"))
CHUNK_SIZE        = int(os.getenv("CHUNK_SIZE", "400"))   # words per chunk
CHUNK_OVERLAP     = int(os.getenv("CHUNK_OVERLAP", "50")) # word overlap between chunks


def parse_optional_positive_int_env(name: str) -> int | None:
    raw = (os.getenv(name) or "").strip()
    if not raw:
        return None
    try:
        value = int(raw)
        return value if value > 0 else None
    except ValueError:
        return None


API_EMBED_DIMENSIONS = parse_optional_positive_int_env("API_EMBED_DIMENSIONS")


def parse_csv_env(name: str) -> set[str]:
    raw = os.getenv(name, "")
    return {item.strip().lower() for item in raw.split(",") if item.strip()}


def normalize_api_key(raw: str) -> str:
    value = (raw or "").strip()
    if not value:
        return ""
    return re.sub(r"^Bearer\s+", "", value, flags=re.IGNORECASE).strip()


OLLAMA_ALLOWED_HOSTS = parse_csv_env("OLLAMA_ALLOWED_HOSTS")
OLLAMA_ALLOWED_SUFFIXES = parse_csv_env("OLLAMA_ALLOWED_SUFFIXES")
OPENAI_COMPAT_BASE_PATH = os.getenv("OPENAI_COMPAT_BASE_PATH", "/v1")

if not SUPABASE_URL or not SUPABASE_KEY:
    raise RuntimeError("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in backend/.env")

sb = create_client(SUPABASE_URL, SUPABASE_KEY)


# ── helpers ──────────────────────────────────────────────────────────────────

def chunk_text(text: str) -> list[str]:
    """Split text into overlapping word-based chunks."""
    words = text.split()
    chunks, i = [], 0
    while i < len(words):
        chunk = " ".join(words[i : i + CHUNK_SIZE])
        if chunk.strip():
            chunks.append(chunk)
        i += CHUNK_SIZE - CHUNK_OVERLAP
    return chunks


@lru_cache(maxsize=1)
def get_espeak_voice_names() -> set[str]:
    """Return the set of installed espeak voice names."""
    espeak_bin = shutil.which("espeak-ng") or shutil.which("espeak")
    if not espeak_bin:
        return set()

    try:
        import subprocess

        result = subprocess.run([espeak_bin, "--voices"], check=False, capture_output=True, text=True)
    except Exception:
        return set()

    voices: set[str] = set()
    for line in result.stdout.splitlines():
        parts = line.split()
        if len(parts) >= 4 and parts[0].isdigit():
            voices.add(parts[3])
    return voices


def parse_json_block(text: str) -> dict:
    """Extract the first JSON object from a model response."""
    cleaned = text.strip().replace("```json", "").replace("```", "")
    try:
        parsed = json.loads(cleaned)
        if isinstance(parsed, dict):
            return parsed
    except json.JSONDecodeError:
        pass

    start = cleaned.find("{")
    if start == -1:
        raise ValueError("Model did not return JSON")

    decoder = json.JSONDecoder()
    try:
        parsed, _ = decoder.raw_decode(cleaned[start:])
    except json.JSONDecodeError as e:
        # Fallback: try a broad object slice if model wrapped JSON with prose.
        match = re.search(r"\{[\s\S]*\}", cleaned)
        if not match:
            raise ValueError("Model did not return parseable JSON") from e
        parsed = json.loads(match.group(0))

    if not isinstance(parsed, dict):
        raise ValueError("Model returned non-object JSON")
    return parsed


def normalize_ollama_url(url: str) -> str:
    normalized = (url or "").strip().rstrip("/")
    if not normalized:
        raise ValueError("Ollama URL cannot be empty")

    parsed = urlparse(normalized)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("Ollama URL must be a valid http(s) URL")

    return normalized


def is_allowed_ollama_host(hostname: str) -> bool:
    host = (hostname or "").strip().lower()
    if not host:
        return False

    if not OLLAMA_ALLOWED_HOSTS and not OLLAMA_ALLOWED_SUFFIXES:
        return True

    if host in OLLAMA_ALLOWED_HOSTS:
        return True

    return any(host == suffix or host.endswith(f".{suffix}") for suffix in OLLAMA_ALLOWED_SUFFIXES)


def validate_ollama_endpoint(url: str) -> str:
    normalized = normalize_ollama_url(url)
    parsed = urlparse(normalized)
    hostname = (parsed.hostname or "").strip().lower()

    if not is_allowed_ollama_host(hostname):
        raise ValueError(
            "Host is not in allowlist. Configure OLLAMA_ALLOWED_HOSTS or OLLAMA_ALLOWED_SUFFIXES."
        )

    # Force HTTPS for non-localhost endpoints to avoid sending prompts to cleartext endpoints.
    if hostname not in {"localhost", "127.0.0.1", "::1"} and parsed.scheme != "https":
        raise ValueError("Non-local Ollama endpoints must use https")

    return normalized


def resolve_ollama_url(request: Request) -> str:
    # Allow users to supply a per-request endpoint so each user can target
    # their own local Ollama tunnel without changing global Render env vars.
    header_url = request.headers.get("x-ollama-url")
    if not header_url:
        try:
            return validate_ollama_endpoint(OLLAMA_URL)
        except ValueError as exc:
            raise HTTPException(500, f"Invalid backend OLLAMA_URL configuration: {exc}") from exc
    try:
        return validate_ollama_endpoint(header_url)
    except ValueError as exc:
        raise HTTPException(400, f"Invalid x-ollama-url header: {exc}") from exc


def is_api_key_mode(request: Request) -> bool:
    return (request.headers.get("x-ai-mode") or "").strip().lower() == "api-key"


def build_openai_compat_url(base_url: str, path: str) -> str:
    base = base_url.rstrip("/")
    normalized_path = path if path.startswith("/") else f"/{path}"
    base_path = OPENAI_COMPAT_BASE_PATH if OPENAI_COMPAT_BASE_PATH.startswith("/") else f"/{OPENAI_COMPAT_BASE_PATH}"
    if base.endswith(base_path):
        return f"{base}{normalized_path}"
    return f"{base}{base_path}{normalized_path}"


def normalize_openai_compat_model(model: str, ai_url: str) -> str:
    """
    Normalize model IDs for OpenRouter-style OpenAI-compatible gateways.

    OpenRouter commonly expects provider-prefixed model names such as
    `openai/gpt-4o-mini` and `openai/text-embedding-3-small`. If a bare model
    name is configured, prefix it so the upstream gateway can resolve it.
    """
    value = (model or "").strip()
    if not value:
        return value

    host = (urlparse(ai_url).hostname or "").strip().lower()
    if host.endswith("openrouter.ai") and "/" not in value:
        return f"openai/{value}"

    return value


def get_mode_models(api_key_mode: bool) -> dict[str, str]:
    if api_key_mode:
        return {
            "chat": API_CHAT_MODEL,
            "quiz": API_QUIZ_MODEL,
            "flashcard": API_FLASHCARD_MODEL,
            "embed": API_EMBED_MODEL,
        }
    return {
        "chat": LOCAL_CHAT_MODEL,
        "quiz": LOCAL_QUIZ_MODEL,
        "flashcard": LOCAL_FLASHCARD_MODEL,
        "embed": LOCAL_EMBED_MODEL,
    }


def get_upstream_ai_headers(request: Request, api_key_mode: bool = False, ai_url: str = "") -> dict[str, str]:
    api_key = normalize_api_key(request.headers.get("x-ollama-api-key") or "")
    if api_key_mode and not api_key:
        raise HTTPException(
            400,
            "API key mode is enabled, but no API key was provided. Save an API key in Profile -> AI Endpoint.",
        )
    if not api_key:
        return {}

    host = (urlparse(ai_url).hostname or "").strip().lower() if ai_url else ""
    is_azure_openai = host.endswith("openai.azure.com") or host.endswith("cognitiveservices.azure.com")

    # Azure OpenAI expects api-key, while OpenAI/OpenRouter/Groq-compatible gateways
    # typically expect Authorization: Bearer.
    if is_azure_openai:
        return {"api-key": api_key}

    return {"Authorization": f"Bearer {api_key}"}


def get_current_user_id(request: Request) -> str:
    auth_header = (request.headers.get("authorization") or "").strip()
    if not auth_header.lower().startswith("bearer "):
        raise HTTPException(401, "Missing bearer token")

    token = auth_header[7:].strip()
    if not token:
        raise HTTPException(401, "Missing bearer token")

    try:
        user_response = sb.auth.get_user(token)
    except Exception as e:
        raise HTTPException(401, f"Invalid session token: {e}") from e

    user = getattr(user_response, "user", None)
    user_id = getattr(user, "id", None)
    if not user_id:
        raise HTTPException(401, "Unable to resolve current user")

    return str(user_id)


async def get_embedding(
    text: str,
    embed_model: str,
    ai_url: str,
    upstream_headers: dict[str, str] | None = None,
    api_key_mode: bool = False,
) -> list[float]:
    """Call embeddings API for either Ollama or OpenAI-compatible providers."""
    try:
        payload = {"model": normalize_openai_compat_model(embed_model, ai_url)}
        endpoint = f"{ai_url}/api/embeddings"
        if api_key_mode:
            endpoint = build_openai_compat_url(ai_url, "/embeddings")
            payload["input"] = text
            if API_EMBED_DIMENSIONS is not None:
                payload["dimensions"] = API_EMBED_DIMENSIONS
        else:
            payload["prompt"] = text

        async with httpx.AsyncClient(timeout=60) as client:
            r = await client.post(
                endpoint,
                headers=upstream_headers or None,
                json=payload,
            )
            r.raise_for_status()

            data = r.json()
            if api_key_mode:
                items = data.get("data") if isinstance(data, dict) else None
                if isinstance(items, list) and items:
                    first = items[0]
                    if isinstance(first, dict) and isinstance(first.get("embedding"), list):
                        return first["embedding"]
                raise HTTPException(502, "OpenAI-compatible embeddings response missing data[0].embedding")

            if isinstance(data, dict) and isinstance(data.get("embedding"), list):
                return data["embedding"]
            raise HTTPException(502, "Ollama embeddings response missing embedding")
    except httpx.RequestError as e:
        if api_key_mode:
            # Fall back to local embeddings if API mode fails
            try:
                return await get_embedding(text, LOCAL_EMBED_MODEL, validate_ollama_endpoint(OLLAMA_URL), None, False)
            except Exception:
                raise HTTPException(503, f"Could not reach AI endpoint at {ai_url}: {e}") from e
        raise HTTPException(503, f"Could not reach AI endpoint at {ai_url}: {e}") from e
    except httpx.HTTPStatusError as e:
        if api_key_mode:
            # Fall back to local embeddings if API embeddings model not available
            try:
                return await get_embedding(text, LOCAL_EMBED_MODEL, validate_ollama_endpoint(OLLAMA_URL), None, False)
            except Exception:
                raise HTTPException(502, f"Embeddings request failed ({e.response.status_code}): {e.response.text[:300]}") from e
        raise HTTPException(502, f"Embeddings request failed ({e.response.status_code}): {e.response.text[:300]}") from e


async def generate_text(
    prompt: str,
    model: str,
    ai_url: str,
    upstream_headers: dict[str, str] | None = None,
    api_key_mode: bool = False,
) -> str:
    try:
        endpoint = f"{ai_url}/api/generate"
        payload: dict = {"model": model, "prompt": prompt, "stream": False}
        if api_key_mode:
            endpoint = build_openai_compat_url(ai_url, "/chat/completions")
            payload = {
                "model": normalize_openai_compat_model(model, ai_url),
                "messages": [
                    {"role": "user", "content": prompt},
                ],
                "temperature": 0.2,
            }

        async with httpx.AsyncClient(timeout=180) as client:
            r = await client.post(endpoint, headers=upstream_headers or None, json=payload)
            r.raise_for_status()
            data = r.json()

            if api_key_mode:
                choices = data.get("choices") if isinstance(data, dict) else None
                if isinstance(choices, list) and choices:
                    message = choices[0].get("message") if isinstance(choices[0], dict) else None
                    content = message.get("content") if isinstance(message, dict) else ""
                    if isinstance(content, str):
                        return content
                    if isinstance(content, list):
                        chunks = [item.get("text", "") for item in content if isinstance(item, dict)]
                        joined = "".join(chunks).strip()
                        if joined:
                            return joined
                raise HTTPException(502, "OpenAI-compatible response missing choices[0].message.content")

            response_text = data.get("response") if isinstance(data, dict) else None
            if isinstance(response_text, str):
                return response_text
            raise HTTPException(502, "Ollama response missing response field")
    except httpx.RequestError as e:
        raise HTTPException(503, f"Could not reach AI endpoint at {ai_url}: {e}") from e
    except httpx.HTTPStatusError as e:
        raise HTTPException(502, f"Generation request failed ({e.response.status_code}): {e.response.text[:300]}") from e

def synthesize_with_espeak(text: str, speed: float = 1.0, voice: str = "default") -> bytes:
    """Generate speech audio from text using espeak-ng."""
    if TTS_ENGINE not in {"espeak", "espeak-ng"}:
        raise HTTPException(500, f"Unsupported TTS_ENGINE '{TTS_ENGINE}'. Use espeak-ng.")

    espeak_bin = shutil.which("espeak-ng") or shutil.which("espeak")
    if not espeak_bin:
        raise HTTPException(500, "espeak-ng binary not found on the system")

    speed_value = max(80, min(450, int(175 * speed)))
    voice_value = voice if voice and voice != "default" else TTS_VOICE
    available_voices = get_espeak_voice_names()
    if available_voices and voice_value not in available_voices:
        voice_value = TTS_VOICE if TTS_VOICE in available_voices else "en-us"

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        wav_path = tmp.name

    try:
        import subprocess

        result = subprocess.run(
            [espeak_bin, "-v", voice_value, "-s", str(speed_value), "-w", wav_path, text],
            check=False,
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            raise HTTPException(500, f"espeak-ng synthesis failed: {result.stderr.strip() or result.stdout.strip() or 'unknown error'}")

        with open(wav_path, "rb") as f:
            audio = f.read()

        if not audio:
            raise HTTPException(500, "espeak-ng returned no audio")

        return audio
    finally:
        try:
            os.unlink(wav_path)
        except Exception:
            pass


# ── routes ───────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    espeak_bin = shutil.which("espeak-ng") or shutil.which("espeak")
    return {
        "status": "ok",
        "local_embed_model": LOCAL_EMBED_MODEL,
        "api_embed_model": API_EMBED_MODEL,
        "api_embed_dimensions": API_EMBED_DIMENSIONS,
        "local_chat_model": LOCAL_CHAT_MODEL,
        "api_chat_model": API_CHAT_MODEL,
        "local_quiz_model": LOCAL_QUIZ_MODEL,
        "api_quiz_model": API_QUIZ_MODEL,
        "local_flashcard_model": LOCAL_FLASHCARD_MODEL,
        "api_flashcard_model": API_FLASHCARD_MODEL,
        "default_ollama_url": OLLAMA_URL,
        "ollama_allowed_hosts": sorted(OLLAMA_ALLOWED_HOSTS),
        "ollama_allowed_suffixes": sorted(OLLAMA_ALLOWED_SUFFIXES),
        "tts_engine": TTS_ENGINE,
        "tts_binary": espeak_bin,
        "tts_voice": TTS_VOICE,
        "tts_default_speed": TTS_DEFAULT_SPEED,
    }


@app.get("/")
def root():
    return {
        "status": "ok",
        "message": "StudyMind RAG backend is running",
        "health": "/health",
        "docs": "/docs",
    }


@app.get("/ai-health")
async def ai_health(request: Request):
    ai_url = resolve_ollama_url(request)
    api_key_mode = is_api_key_mode(request)
    upstream_headers = get_upstream_ai_headers(request, api_key_mode, ai_url)

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            if api_key_mode:
                # Lightweight probe: GET /models costs zero tokens and confirms
                # the key is valid and the endpoint is reachable.
                models_url = build_openai_compat_url(ai_url, "/models")
                models_res = await client.get(models_url, headers=upstream_headers or None)
                models_res.raise_for_status()
            else:
                health_url = f"{ai_url}/api/tags"
                res = await client.get(health_url, headers=upstream_headers or None)
                res.raise_for_status()
    except httpx.RequestError as e:
        raise HTTPException(503, f"Could not reach AI endpoint at {ai_url}: {e}") from e
    except httpx.HTTPStatusError as e:
        raise HTTPException(502, f"AI endpoint health check failed ({e.response.status_code}): {e.response.text[:300]}") from e

    return {
        "status": "ok",
        "mode": "api-key" if api_key_mode else "local",
        "endpoint": ai_url,
    }


@app.delete("/account")
async def delete_account(request: Request):
    user_id = get_current_user_id(request)

    try:
        sb.auth.admin.delete_user(user_id)
    except Exception as e:
        raise HTTPException(500, f"Failed to delete account: {e}") from e

    return {"ok": True}


@app.post("/upload")
async def upload_pdf(
    request: Request,
    file: UploadFile = File(...),
    user_id: str = Query(...),
    note_id: str = Query(...),
):
    """
    1. Extract text from PDF
    2. Chunk it
    3. Embed each chunk via Ollama
    4. Store chunks in Supabase document_chunks table
    Returns the full extracted text so the frontend can fill the note body.
    """
    if not file.filename.lower().endswith(".pdf"):
        raise HTTPException(400, "Only PDF files are supported")

    contents = await file.read()

    # Extract text
    try:
        doc = fitz.open(stream=contents, filetype="pdf")
        pages_text = [page.get_text() for page in doc]
        doc.close()
        full_text = "\n\n".join(pages_text).strip()
    except Exception as e:
        raise HTTPException(500, f"PDF parsing failed: {e}")

    if not full_text:
        raise HTTPException(400, "No extractable text found in this PDF (it may be scanned/image-based)")

    chunks = chunk_text(full_text)
    ai_url = resolve_ollama_url(request)
    api_key_mode = is_api_key_mode(request)
    mode_models = get_mode_models(api_key_mode)
    upstream_headers = get_upstream_ai_headers(request, api_key_mode, ai_url)

    # Delete any existing chunks for this note (re-upload scenario)
    try:
        sb.table("document_chunks").delete().eq("note_id", note_id).execute()
    except Exception as e:
        raise HTTPException(500, f"Failed to clear existing chunks: {e}") from e

    # Embed + store chunks
    rows = []
    for i, chunk in enumerate(chunks):
        embedding = await get_embedding(chunk, mode_models["embed"], ai_url, upstream_headers, api_key_mode)
        rows.append({
            "note_id":     note_id,
            "user_id":     user_id,
            "content":     chunk,
            "chunk_index": i,
            "embedding":   embedding,
        })

    # Insert in batches of 50 to stay within payload limits
    batch_size = 50
    try:
        for start in range(0, len(rows), batch_size):
            sb.table("document_chunks").insert(rows[start : start + batch_size]).execute()
    except Exception as e:
        error_text = str(e)
        lower = error_text.lower()
        if "dimensions" in lower and "expected" in lower:
            raise HTTPException(
                400,
                "Embedding dimension mismatch while saving chunks. "
                "Set API_EMBED_DIMENSIONS to match your database vector size (for this project, use 768), "
                "then re-upload the PDF.",
            ) from e
        raise HTTPException(500, f"Failed to store chunk embeddings in Supabase: {e}") from e

    return {
        "ok":     True,
        "chunks": len(chunks),
        "text":   full_text,
    }


class QueryRequest(BaseModel):
    question: str
    note_id:  str = ""
    user_id:  str
    model:    str = ""   # optional override; falls back to CHAT_MODEL


class QuizRequest(BaseModel):
    content: str
    count: int = 5
    difficulty: str = "medium"
    model: str = ""  # optional override; falls back to QUIZ_MODEL


class FlashcardsRequest(BaseModel):
    content: str
    count: int = 10
    model: str = ""  # optional override; falls back to FLASHCARD_MODEL


class SummaryRequest(BaseModel):
    content: str
    max_points: int = 8
    mode: str = "standard"
    model: str = ""  # optional override; falls back to CHAT_MODEL


class TTSRequest(BaseModel):
    text: str
    voice: str = "default"
    speed: float = 1.0


@app.post("/query")
async def query_rag(req: QueryRequest, request: Request):
    """
    1. Embed the question
    2. Similarity-search document_chunks via pgvector RPC
    3. Build prompt with top-k context
    4. Call Ollama chat model
    Returns the answer + source chunks.
    """
    ai_url = resolve_ollama_url(request)
    api_key_mode = is_api_key_mode(request)
    mode_models = get_mode_models(api_key_mode)
    model = req.model or mode_models["chat"]
    upstream_headers = get_upstream_ai_headers(request, api_key_mode, ai_url)

    sources = []

    if req.note_id:
        q_embedding = await get_embedding(req.question, mode_models["embed"], ai_url, upstream_headers, api_key_mode)

        # Vector search
        try:
            result = sb.rpc("match_chunks", {
                "query_embedding": q_embedding,
                "match_note_id":   req.note_id,
                "match_count":     5,
            }).execute()
        except Exception as e:
            error_text = str(e)
            if "different vector dimensions" in error_text.lower():
                raise HTTPException(
                    400,
                    "This note was embedded with a different AI embedding model. "
                    "Please re-upload the PDF (or re-embed the note) in the current AI mode, then try Ask this doc again.",
                ) from e
            raise HTTPException(500, f"Vector search failed: {e}") from e

        if result.data:
            sources = [r["content"] for r in result.data]

    if sources:
        context = "\n\n---\n\n".join(sources)
        prompt = f"""You are a helpful study assistant. Answer the question using ONLY the context below from the user's document.
If the answer isn't in the context, say so clearly.

Context:
{context}

Question: {req.question}

Answer:"""
    else:
        prompt = f"""You are a helpful study assistant. Answer clearly and concisely.

Question: {req.question}

Answer:"""

    answer = await generate_text(prompt, model, ai_url, upstream_headers, api_key_mode)

    return {"answer": answer, "sources": sources}


@app.post("/quiz-generate")
async def generate_quiz(req: QuizRequest, request: Request):
    content = (req.content or "").strip()
    if not content:
        raise HTTPException(400, "content required")

    count = max(1, min(20, int(req.count)))
    difficulty = (req.difficulty or "medium").strip().lower()
    if difficulty not in {"easy", "medium", "hard"}:
        difficulty = "medium"

    ai_url = resolve_ollama_url(request)
    api_key_mode = is_api_key_mode(request)
    mode_models = get_mode_models(api_key_mode)
    model = req.model or mode_models["quiz"]
    upstream_headers = get_upstream_ai_headers(request, api_key_mode, ai_url)

    prompt = f"""Generate {count} multiple-choice quiz questions from the study material below.
Return ONLY valid JSON in this exact shape:
{{
  "title": "short quiz title",
  "questions": [
    {{
      "question": "...",
      "options": ["A", "B", "C", "D"],
      "correctIndex": 0,
      "explanation": "..."
    }}
  ]
}}

Rules:
- Exactly 4 options per question.
- correctIndex must be 0..3.
- Difficulty must be {difficulty}.
- Easy: recall and direct understanding.
- Medium: application and comparison.
- Hard: multi-step reasoning and edge cases.
- No markdown, no comments, JSON only.

Study material:
{content[:12000]}
"""

    raw = await generate_text(prompt, model, ai_url, upstream_headers, api_key_mode)

    try:
        parsed = parse_json_block(raw)
    except Exception as e:
        raise HTTPException(502, f"Could not parse quiz JSON from model response: {e}") from e

    title = parsed.get("title") or "Generated Quiz"
    questions = parsed.get("questions")
    if not isinstance(questions, list) or not questions:
        raise HTTPException(502, "Model response missing questions array")

    normalized_questions = []
    for idx, q in enumerate(questions):
        if not isinstance(q, dict):
            continue
        question = str(q.get("question", "")).strip()
        options = q.get("options")
        explanation = str(q.get("explanation", "")).strip()
        if not question:
            continue

        # Accept multiple option formats from smaller/local models.
        normalized_options: list[str] = []
        if isinstance(options, list):
            normalized_options = [str(o).strip() for o in options if str(o).strip()]
        elif isinstance(options, dict):
            ordered_keys = ["A", "B", "C", "D", "a", "b", "c", "d", "1", "2", "3", "4"]
            for key in ordered_keys:
                if key in options and str(options[key]).strip():
                    normalized_options.append(str(options[key]).strip())
            if not normalized_options:
                normalized_options = [str(v).strip() for v in options.values() if str(v).strip()]
        elif isinstance(options, str):
            lines = [line.strip(" -\t") for line in options.splitlines()]
            normalized_options = [line for line in lines if line]

        if len(normalized_options) < 2:
            continue

        # Enforce exactly 4 options for the frontend contract.
        if len(normalized_options) > 4:
            normalized_options = normalized_options[:4]
        while len(normalized_options) < 4:
            normalized_options.append(f"Option {len(normalized_options) + 1}")

        correct_index = q.get("correctIndex", q.get("correct_index", q.get("answerIndex", q.get("answer"))))

        try:
            ci = int(correct_index)
        except Exception:
            if isinstance(correct_index, str):
                answer_token = correct_index.strip()
                letter_map = {"A": 0, "B": 1, "C": 2, "D": 3, "a": 0, "b": 1, "c": 2, "d": 3}
                if answer_token in letter_map:
                    ci = letter_map[answer_token]
                else:
                    match_idx = next((i for i, opt in enumerate(normalized_options) if opt.lower() == answer_token.lower()), -1)
                    ci = match_idx if match_idx >= 0 else 0
            else:
                ci = 0

        if ci < 0 or ci > 3:
            ci = 0

        normalized_questions.append({
            "question": question,
            "options": normalized_options,
            "correctIndex": ci,
            "explanation": explanation or f"Review the key idea behind question {idx + 1}.",
        })

    if not normalized_questions:
        raise HTTPException(502, "Model returned invalid quiz question format")

    return {"title": str(title), "questions": normalized_questions[:count]}


@app.post("/flashcards-generate")
async def generate_flashcards(req: FlashcardsRequest, request: Request):
    content = (req.content or "").strip()
    if not content:
        raise HTTPException(400, "content required")

    count = max(1, min(50, int(req.count)))
    ai_url = resolve_ollama_url(request)
    api_key_mode = is_api_key_mode(request)
    mode_models = get_mode_models(api_key_mode)
    model = req.model or mode_models["flashcard"]
    upstream_headers = get_upstream_ai_headers(request, api_key_mode, ai_url)

    prompt = f"""Generate {count} high-quality study flashcards from the material below.
Return ONLY valid JSON in this exact shape:
{{
  "title": "short deck title",
  "cards": [
    {{
      "front": "clear question or prompt",
      "back": "concise answer"
    }}
  ]
}}

Rules:
- Keep each front and back concise and factual.
- Avoid duplicates.
- No markdown, no comments, JSON only.

Study material:
{content[:12000]}
"""

    raw = await generate_text(prompt, model, ai_url, upstream_headers, api_key_mode)

    try:
        parsed = parse_json_block(raw)
    except Exception as e:
        raise HTTPException(502, f"Could not parse flashcards JSON from model response: {e}") from e

    title = parsed.get("title") or "Generated Flashcards"
    cards = parsed.get("cards")
    if not isinstance(cards, list) or not cards:
        raise HTTPException(502, "Model response missing cards array")

    normalized_cards = []
    for c in cards:
        if not isinstance(c, dict):
            continue
        front = str(c.get("front", "")).strip()
        back = str(c.get("back", "")).strip()
        if front and back:
            normalized_cards.append({"front": front, "back": back})

    if not normalized_cards:
        raise HTTPException(502, "Model returned invalid flashcard format")

    return {"title": str(title), "cards": normalized_cards[:count]}


@app.post("/summarize-note")
async def summarize_note(req: SummaryRequest, request: Request):
    content = (req.content or "").strip()
    if not content:
        raise HTTPException(400, "content required")

    max_points = max(3, min(15, int(req.max_points)))
    mode = (req.mode or "standard").strip().lower()
    ai_url = resolve_ollama_url(request)
    api_key_mode = is_api_key_mode(request)
    mode_models = get_mode_models(api_key_mode)
    model = req.model or mode_models["chat"]
    upstream_headers = get_upstream_ai_headers(request, api_key_mode, ai_url)

    if mode == "eli5":
        prompt = f"""You are helping a student understand a topic like they are 10 years old.

Return ONLY valid JSON in this exact shape:
{{
  "title": "short friendly title",
  "summary": "2-4 sentence plain-language explanation",
  "analogy": "one simple analogy",
  "bullets": ["short point", "..."],
  "key_terms": ["term", "..."] ,
  "visual_flow": [
    {{ "label": "step name", "note": "short explanation" }}
  ]
}}

Rules:
- Keep language simple and concrete.
- visual_flow should have 3 to 6 connected steps.
- bullets should have up to {max_points} items.
- No markdown code blocks.

Study material:
{content[:15000]}
"""

        raw = (await generate_text(prompt, model, ai_url, upstream_headers, api_key_mode)).strip()

        try:
            parsed = parse_json_block(raw)
        except Exception:
            # Fallback to plain summary if the model returns malformed JSON.
            return {
                "mode": "eli5",
                "title": "ELI5 Summary",
                "summary": raw or "No summary generated.",
                "analogy": "",
                "bullets": [],
                "key_terms": [],
                "visual_flow": [],
            }

        visual_flow = parsed.get("visual_flow") if isinstance(parsed.get("visual_flow"), list) else []
        normalized_flow = []
        for item in visual_flow[:6]:
            if not isinstance(item, dict):
                continue
            label = str(item.get("label", "")).strip()
            note = str(item.get("note", "")).strip()
            if label:
                normalized_flow.append({"label": label, "note": note})

        bullets = parsed.get("bullets") if isinstance(parsed.get("bullets"), list) else []
        key_terms = parsed.get("key_terms") if isinstance(parsed.get("key_terms"), list) else []

        normalized_bullets = [str(b).strip() for b in bullets[:max_points] if str(b).strip()]

        # Guarantee visual output in ELI5 mode even if the model omits visual_flow.
        if not normalized_flow:
            seed_points = normalized_bullets[:4]
            if not seed_points:
                seed_points = [s.strip() for s in str(parsed.get("summary", "")).split(".") if s.strip()][:4]

            for idx, point in enumerate(seed_points, start=1):
                normalized_flow.append({
                    "label": f"Step {idx}",
                    "note": point,
                })

        return {
            "mode": "eli5",
            "title": str(parsed.get("title", "ELI5 Summary")).strip() or "ELI5 Summary",
            "summary": str(parsed.get("summary", "")).strip() or raw,
            "analogy": str(parsed.get("analogy", "")).strip(),
            "bullets": normalized_bullets,
            "key_terms": [str(k).strip() for k in key_terms[:12] if str(k).strip()],
            "visual_flow": normalized_flow,
        }

    prompt = f"""Summarize the study material below for a student.

Output format:
- Start with a one-line title.
- Then provide up to {max_points} concise bullet points.
- End with a short "Key terms:" line listing the most important terms.

Rules:
- Keep it clear and factual.
- Avoid markdown code blocks.
- Do not invent details that are not present in the material.

Study material:
{content[:15000]}
"""

    summary = (await generate_text(prompt, model, ai_url, upstream_headers, api_key_mode)).strip()

    if not summary:
        raise HTTPException(502, "Model returned an empty summary")

    return {
        "mode": "standard",
        "title": "Summary",
        "summary": summary,
        "analogy": "",
        "bullets": [],
        "key_terms": [],
        "visual_flow": [],
    }


@app.post("/tts-generate")
async def tts_generate(req: TTSRequest):
    text = (req.text or "").strip()
    if not text:
        raise HTTPException(400, "text required")

    clipped = text[:TTS_MAX_CHARS]
    audio = synthesize_with_espeak(clipped, req.speed or TTS_DEFAULT_SPEED, req.voice)
    return Response(content=audio, media_type="audio/wav")
