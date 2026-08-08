<p align="center">
   <img src="https://img.shields.io/badge/StudyMind-AI%20study%20assistant-FF6B35?style=for-the-badge&logo=github&logoColor=white&labelColor=111827" alt="StudyMind" />
</p>

<p align="center">
   <strong>
      Study smarter with notes, quizzes, flashcards, and configurable AI models.
   </strong><br/>
   API key mode is the default. Switch to local Ollama mode when you want to run your own model locally.
</p>

<p align="center">
   <a href="https://studymind-henna.vercel.app"><img src="https://img.shields.io/badge/Live%20Demo-Open%20app-0EA5E9?style=for-the-badge&logo=vercel&logoColor=white" alt="Live demo" /></a>
   <a href="https://github.com/c-varshith/studymind"><img src="https://img.shields.io/badge/GitHub-Source%20repo-111827?style=for-the-badge&logo=github&logoColor=white" alt="Source repo" /></a>
   <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-111827?style=for-the-badge" alt="MIT license" /></a>
   <a href="#ai-connection-modes"><img src="https://img.shields.io/badge/AI%20Modes-API%20key%20%2B%20Local-FF6B35?style=for-the-badge&labelColor=111827" alt="AI modes" /></a>
</p>

<p align="center">
   <a href="#features">Features</a> &bull;
   <a href="#ai-connection-modes">AI modes</a> &bull;
   <a href="#running-locally">Setup</a> &bull;
   <a href="#tech-stack">Stack</a>
</p>

> **Default:** API key mode. Use local Ollama only when you want to self-host the model endpoint.

| At a glance | Value |
|---|---|
| Live demo | https://studymind-henna.vercel.app |
| Default AI mode | API key mode |
| Optional local mode | Ollama via local dev or ngrok tunnel |
| Backend | FastAPI + Python |

---

## Features

- **PDF Upload & Embedding** — Upload notes and have them chunked + embedded into a vector database
- **RAG Chat + Tutor History** — Ask questions about your uploaded notes with context-aware answers and reopen saved tutor conversations
- **Quiz Generation** — Auto-generate multiple choice quizzes from your notes
- **Flashcard Generation** — Create study flashcards instantly
- **Summarization** — Get concise summaries of your notes
- **Smart PDF Export** — Download a polished PDF in one click (exports note content, summary, or simplified analysis automatically based on what is currently available)
- **Text-to-Speech** — Listen to your notes read aloud
- **Formatted PDF Output** — Exported PDFs include structured headings, readable spacing, section dividers, and page numbers for better readability

---

## Architecture

```
┌─────────────────────┐        ┌──────────────────────┐
│   Frontend (Vercel) │──────▶ │  Backend (Render)    │
│   React + Vite      │        │  FastAPI + Python    │
└─────────────────────┘        └──────────┬───────────┘
                                          │
                    ┌─────────────────────┼───────────────────┐
                    │                     │                   │
           ┌────────▼──────┐    ┌─────────▼─────────┐  ┌──────▼──────┐
           │ Supabase      │    │ ngrok tunnel      │  │ Local Ollama│
           │ (Postgres +   │    │ (public HTTPS URL)│  │ on your     │
           │  pgvector)    │    └──────────┬────────┘  │ machine)    │
           └───────────────┘               │           └──────▲──────┘
                                           └──────────────────┘
```

## AI Connection Modes

StudyMind supports two AI modes from **Profile -> AI Endpoint**:

- **API key mode (default):** enter an endpoint URL and API key, then save. The app sends the key only in API key mode.
- **Local model mode:** enable local mode to use Ollama on your own machine, either directly in local dev or through a tunnel for hosted frontend/backend.

Use **Test connection** in the same Profile section to verify your current settings before using chat, quiz, flashcards, summaries, or PDF embedding.

> ⚠️ If local mode is enabled and your Ollama/tunnel is down, AI features will fail.

### Local Mode Setup (Optional)

#### Step 1 — Run Ollama locally

Install [Ollama](https://ollama.com), pull the required models, and start the server:

```bash
ollama pull llama3.1          # ~4.7 GB — chat & generation model
ollama pull nomic-embed-text  # ~274 MB — embedding model
ollama serve
```

#### Step 2 — Expose Ollama via ngrok (for hosted app usage)

The backend on Render can't reach `localhost` directly, so ngrok gives it a public HTTPS URL.

1. Install [ngrok](https://ngrok.com) and authenticate your account.
2. Run:
   ```bash
   ngrok http 11434 --host-header="localhost:11434"
   ```
3. Copy the `https://xxxx-xxxx.ngrok-free.dev` URL from the terminal output.
4. Open https://studymind-henna.vercel.app, go to **Profile -> AI Endpoint**, turn on **Use local model**, and paste the ngrok URL.

> **Free ngrok URLs are ephemeral.** They change every time ngrok restarts. Each user should update their own URL in **Profile -> AI Endpoint** when it changes.

Once both are running, head to the site, upload a PDF, and start chatting.

### API Key Mode Setup

If you want to use a hosted/provider endpoint instead of local Ollama:

1. Go to **Profile -> AI Endpoint**.
2. Turn off **Use local model**.
3. Enter your AI endpoint URL.
4. Enter your API key.
5. Click **Save AI settings**.
6. Click **Test connection**.

> ✅ **Important:** In API-key mode, enter both **endpoint URL** and **API key** in Profile. Only leave URL empty if your backend default `OLLAMA_URL` is already set to the same provider endpoint (for example `https://openrouter.ai/api/v1`).

Notes:

- The API key is stored in browser local storage for that user/session on that browser.
- The backend sends credentials using `Authorization: Bearer <key>` and `api-key: <key>` headers.
- API-key mode supports OpenAI-compatible APIs directly (no LiteLLM required).

#### Direct provider examples (no gateway)

- OpenRouter endpoint URL: `https://openrouter.ai/api/v1`
- OpenAI endpoint URL: `https://api.openai.com/v1`
- Groq endpoint URL: `https://api.groq.com/openai/v1`

Use one of these backend model setups:

1. **Only API-key mode**

```env
API_CHAT_MODEL=openai/gpt-4o-mini
API_QUIZ_MODEL=openai/gpt-4o-mini
API_FLASHCARD_MODEL=openai/gpt-4o-mini
API_EMBED_MODEL=openai/text-embedding-3-small
```

2. **Both local mode and API-key mode (recommended)**

```env
# Local mode models (Ollama-compatible)
LOCAL_CHAT_MODEL=llama3.1
LOCAL_QUIZ_MODEL=llama3.1
LOCAL_FLASHCARD_MODEL=llama3.1
LOCAL_EMBED_MODEL=nomic-embed-text

# API key mode models (OpenAI-compatible)
API_CHAT_MODEL=openai/gpt-4o-mini
API_QUIZ_MODEL=openai/gpt-4o-mini
API_FLASHCARD_MODEL=openai/gpt-4o-mini
API_EMBED_MODEL=openai/text-embedding-3-small
API_EMBED_DIMENSIONS=768
```

You can replace the example model IDs with models available in your provider account.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React, Vite, TypeScript, Tailwind CSS, shadcn/ui |
| Backend | FastAPI, Python 3.12 |
| Database | Supabase (PostgreSQL + pgvector) |
| AI Models | API key-based endpoint by default, with optional local Ollama support (llama3.1, nomic-embed-text) |
| Hosting | Vercel (frontend), Render (backend) |
| Tunnel | ngrok (exposes local Ollama to Render) |

---

## Project Structure

```
studymind/
├── src/                          # React frontend
│   ├── components/               # AppShell, NavLink, ProtectedRoute, shadcn UI
│   ├── hooks/                    # useAuth, useRecorder, use-toast, use-mobile
│   ├── lib/                      # api.ts, rag.ts — backend API calls
│   ├── pages/                    # Landing, Auth, Dashboard, Notes, Chat,
│   │                             # Quiz, Flashcards, Profile, NotFound
│   └── integrations/supabase/    # Supabase client + auto-generated types
│
├── backend/                      # FastAPI backend
│   ├── main.py                   # All API routes
│   ├── requirements.txt          # Python dependencies
│   └── scripts/                  # Optional local TTS helper scripts
│
├── supabase/
│   ├── functions/                # Edge functions
│   │   ├── chat/                 # Streaming chat with note context
│   │   ├── generate-quiz/        # AI quiz generation
│   │   ├── generate-flashcards/  # AI flashcard generation
│   │   ├── tts/                  # Text-to-speech
│   │   └── stt/                  # Speech-to-text
│   └── migrations/               # Database schema migrations
│
├── public/                       # Static assets
├── vercel.json                   # Client-side routing config for Vercel
├── package.json                  # Frontend dependencies
├── requirements.txt              # Root-level Python deps (for Render)
└── index.html                    # Vite entry point
```

---

## Running Locally

### Prerequisites

- Node.js 18+
- Python 3.10–3.12
- [Ollama](https://ollama.com) installed
- A [Supabase](https://supabase.com) project
- [Supabase CLI](https://supabase.com/docs/guides/cli) (for running migrations)

### 1. Clone the repo

```bash
git clone https://github.com/c-varshith/studymind.git
cd studymind
```

### 2. Pull the required Ollama models

```bash
ollama pull llama3.1
ollama pull nomic-embed-text
ollama serve
```

### 3. Initialize the Supabase database

Create a new project at [supabase.com](https://supabase.com), then run the migration to set up all tables, RLS policies, storage bucket, and triggers.

**Option A — Supabase CLI (recommended)**

```bash
# Link to your project (find your project ref in the Supabase dashboard URL)
supabase link --project-ref <your-project-ref>

# Push the migration
supabase db push
```

**Option B — SQL Editor (manual)**

1. Open your Supabase project → **SQL Editor**.
2. Copy the contents of `supabase/migrations/` and paste it into the editor.
3. Click **Run**.

This migration creates the following schema:

| Table | Description |
|-------|-------------|
| `profiles` | User profile, auto-created on signup |
| `notes` | Uploaded notes and their extracted text |
| `conversations` | Chat sessions linked to notes |
| `messages` | Individual chat messages (user + assistant) |
| `quizzes` | Generated quizzes stored as JSONB |
| `flashcard_decks` | Flashcard deck metadata |
| `flashcards` | Individual flashcard front/back pairs |
| `storage.study-files` | Private bucket for uploaded PDFs |

All tables have Row Level Security enabled — users can only access their own data.

### 4. Set up the backend

```bash
cd backend
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

Create `backend/.env`:
```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your-service-role-key
OLLAMA_URL=http://localhost:11434
```

Run the backend:
```bash
uvicorn main:app --reload --port 8000
```

API docs at: `http://localhost:8000/docs`

### 5. Set up the frontend

```bash
# From the project root
npm install
```

Create `.env.local` in the project root:
```env
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=your-anon-key
VITE_RAG_BACKEND_URL=http://localhost:8000
```

Run the frontend:
```bash
npm run dev
```

Frontend at: `http://localhost:5173`

---

## Production Deployment

### Frontend → Vercel

1. Import this repo in [Vercel](https://vercel.com).
2. Framework preset: **Vite**
3. Add environment variables:
   ```
   VITE_SUPABASE_URL=https://your-project.supabase.co
   VITE_SUPABASE_PUBLISHABLE_KEY=your-anon-key
   VITE_RAG_BACKEND_URL=https://your-backend.onrender.com
   ```
4. Deploy — `vercel.json` in the root handles client-side routing automatically.

### Backend → Render

1. Create a new **Web Service** in [Render](https://render.com) from this repo.
2. Set the **Root Directory** to `backend`.
3. Runtime: **Python**
4. Build command: `pip install -r requirements.txt`
5. Start command: `uvicorn main:app --host 0.0.0.0 --port $PORT`
6. Add environment variables:
   ```
   SUPABASE_URL=https://your-project.supabase.co
   SUPABASE_SERVICE_KEY=your-service-role-key
   FRONTEND_URL=https://your-app.vercel.app
   OLLAMA_URL=https://optional-default-ollama-url
   OPENAI_COMPAT_BASE_PATH=/v1
   OLLAMA_ALLOWED_SUFFIXES=ngrok-free.dev,ngrok.app,trycloudflare.com,openrouter.ai,openai.com,groq.com
   OLLAMA_ALLOWED_HOSTS=

   # Local mode models (Ollama)
   LOCAL_CHAT_MODEL=llama3.1
   LOCAL_QUIZ_MODEL=llama3.1
   LOCAL_FLASHCARD_MODEL=llama3.1
   LOCAL_EMBED_MODEL=nomic-embed-text

   # API-key mode models (OpenAI-compatible)
   API_CHAT_MODEL=openai/gpt-4o-mini
   API_QUIZ_MODEL=openai/gpt-4o-mini
   API_FLASHCARD_MODEL=openai/gpt-4o-mini
   API_EMBED_MODEL=openai/text-embedding-3-small
   ```

> ⚠️ **`FRONTEND_URL` is required.** The backend's CORS policy only allows `localhost` origins by default. Without `FRONTEND_URL` set to your Vercel domain, the browser will block all requests from the deployed frontend with a CORS error.

`OLLAMA_URL` is a **default fallback**. Users can override endpoint and mode from the app UI in **Profile -> AI Endpoint**.

### Exposing Ollama via ngrok

```bash
# Start Ollama
ollama serve

# In a new terminal, start ngrok
ngrok http 11434 --host-header="localhost:11434"
```

Copy the `https://xxxx-xxxx.ngrok-free.dev` URL and set it in **Profile -> AI Endpoint** inside the app.

> ⚠️ Free ngrok URLs change on every restart. Update the URL in **Profile -> AI Endpoint** each time, or use a paid ngrok plan for a static domain.

---

## 🔌 API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check |
| GET | `/ai-health` | Validates configured upstream AI endpoint (mode-aware) |
| DELETE | `/account` | Deletes the currently authenticated user's account |
| POST | `/upload` | Upload and embed a PDF |
| POST | `/query` | RAG query against a note |
| POST | `/quiz-generate` | Generate a quiz from a note |
| POST | `/flashcards-generate` | Generate flashcards from a note |
| POST | `/summarize-note` | Summarize a note |
| POST | `/tts-generate` | Text-to-speech generation |

Full interactive docs: `https://your-backend.onrender.com/docs`

---

## Environment Variables

### Backend (Render / local)

| Variable | Required | Description |
|----------|----------|-------------|
| `SUPABASE_URL` | ✅ | Your Supabase project URL |
| `SUPABASE_SERVICE_KEY` | ✅ | Supabase **service role** key (not the anon key) |
| `FRONTEND_URL` | ✅ | Your Vercel frontend URL (e.g. `https://your-app.vercel.app`). Required for CORS — without it, browser requests from the deployed frontend will be blocked. |
| `OLLAMA_URL` | — | Optional default fallback AI endpoint URL. Per-user URL can be set in Profile -> AI Endpoint. |
| `LOCAL_CHAT_MODEL` | — | Local mode chat model (Ollama) |
| `LOCAL_QUIZ_MODEL` | — | Local mode quiz model (Ollama) |
| `LOCAL_FLASHCARD_MODEL` | — | Local mode flashcard model (Ollama) |
| `LOCAL_EMBED_MODEL` | — | Local mode embedding model (Ollama) |
| `API_CHAT_MODEL` | — | API-key mode chat model (OpenAI-compatible provider) |
| `API_QUIZ_MODEL` | — | API-key mode quiz model (OpenAI-compatible provider) |
| `API_FLASHCARD_MODEL` | — | API-key mode flashcard model (OpenAI-compatible provider) |
| `API_EMBED_MODEL` | — | API-key mode embedding model (OpenAI-compatible provider) |
| `API_EMBED_DIMENSIONS` | — | Optional embedding size override for API-key mode (set `768` to match this project's current pgvector schema). |
| `TTS_ENGINE` | — | Optional TTS engine selection for the backend (default: `espeak-ng`). |
| `TTS_VOICE` | — | Default backend TTS voice name (default: `en-us`). |
| `TTS_DEFAULT_SPEED` | — | Default backend TTS playback speed multiplier. |
| `TTS_MAX_CHARS` | — | Maximum text length accepted by the backend TTS endpoint. |
| `OLLAMA_ALLOWED_SUFFIXES` | — | Optional comma-separated domain suffix allowlist for `x-ollama-url` (e.g., `ngrok-free.dev,trycloudflare.com`). |
| `OLLAMA_ALLOWED_HOSTS` | — | Optional comma-separated exact host allowlist for `x-ollama-url`. |
| `OPENAI_COMPAT_BASE_PATH` | — | Optional base path for API-key mode endpoints (default: `/v1`) |

When either allowlist variable is set, any user-provided AI endpoint host outside the allowlist is rejected.
For non-local hosts, the backend also requires `https`.

### Frontend (Vercel / local)

| Variable | Required | Description |
|----------|----------|-------------|
| `VITE_SUPABASE_URL` | ✅ | Your Supabase project URL |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | ✅ | Supabase anon/public key |
| `VITE_RAG_BACKEND_URL` | ✅ | Backend URL in production (e.g. `https://your-backend.onrender.com`). Must be set before deploying — Vite bakes this value at build time. |

### Runtime headers sent by frontend

- Always in local mode: optional `x-ollama-url` when custom endpoint is provided.
- In API key mode: `x-ai-mode: api-key`, optional `x-ollama-url`, and `x-ollama-api-key`.

### API-key mode provider compatibility

- **Native support:** OpenAI-compatible providers (`/chat/completions` + `/embeddings`) like OpenRouter, OpenAI, Groq.
- **Local mode support:** Ollama-compatible providers (`/api/generate` + `/api/embeddings`).

---

## Known Limitations

- **Local mode depends on your own machine/tunnel.** If Ollama or ngrok stops, AI requests in local mode will fail.
- **API key mode requires OpenAI-compatible endpoints.** Providers with non-standard APIs may require backend customization.
- **Free ngrok URLs are ephemeral** — the URL changes on every restart, so each user must refresh their value in Profile -> AI Endpoint unless they use a static tunnel domain.
- **Render cold starts** — the free tier spins down after ~15 minutes of inactivity; the first request after sleep takes ~30 seconds to respond, which exceeds the 10-second health check timeout. Upgrade to a paid Render instance to avoid this.
- **`VITE_RAG_BACKEND_URL` is baked at build time** — adding or changing this variable in Vercel requires a redeploy to take effect.

### Common error: `expected 768 dimensions, not 1536`

If PDF upload fails with a vector dimension error, your API embedding output size does not match the database schema.

Fix:

1. Set `API_EMBED_DIMENSIONS=768` in Render backend env.
2. Redeploy backend.
3. Re-upload the PDF note.

### Common error: `Connection failed — Network error while reaching backend health endpoint`

This means the frontend cannot reach the backend at all. Check in order:

1. **`FRONTEND_URL` not set on Render** — the backend will reject requests from your Vercel domain with a CORS error. Add `FRONTEND_URL=https://your-app.vercel.app` in Render env and restart the service.
2. **`VITE_RAG_BACKEND_URL` not set or wrong on Vercel** — the frontend falls back to `http://127.0.0.1:8000`, which is unreachable in production. Set the correct Render URL and redeploy.
3. **Render cold start** — the free tier sleeps after inactivity. Wait ~30 seconds and try again.

---

## License

This project is licensed under the MIT License. See the full text in [LICENSE](./LICENSE).
