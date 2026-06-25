export const RAG_BACKEND = import.meta.env.DEV
  ? "/api/rag"
  : (import.meta.env.VITE_RAG_BACKEND_URL ?? "http://127.0.0.1:8000");
