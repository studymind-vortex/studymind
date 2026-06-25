import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card } from "@/components/ui/card";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { toast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { summarizeNote, ttsToBlob } from "@/lib/api";
import { uploadPdf, queryRag } from "@/lib/rag";
import { trackActivity } from "@/lib/activity";
import { fetchNotesWithTagSupport, getErrorMessage, updateNoteWithSchemaFallback, type AppNote } from "@/lib/notes";
import {
  Plus, Trash2, Volume2, Loader2,
  FileText, Upload, Send, BookOpen, X, ArrowRight, Download,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useIsMobile } from "@/hooks/use-mobile";
import { jsPDF } from "jspdf";

type Note = AppNote;

type NoteSortMode = "recent" | "alpha-asc" | "alpha-desc";

type DocumentChunksLookup = {
  from(relation: "document_chunks"): {
    select(columns: string, options: { count: "exact"; head: true }): {
      eq(column: "note_id", value: string): Promise<{ count: number | null }>;
    };
  };
};

const TTS_PREVIEW_LIMIT = 12000;
const TTS_SPEED_OPTIONS = [0.8, 1, 1.15, 1.3, 1.5];
const INVISIBLE_RESIZE_HANDLE = "bg-transparent hover:bg-transparent";
const INVISIBLE_HORIZONTAL_RESIZE_HANDLE = "w-1 cursor-col-resize bg-transparent hover:bg-transparent";
const INVISIBLE_VERTICAL_RESIZE_HANDLE = "data-[panel-group-direction=vertical]:h-2 data-[panel-group-direction=vertical]:cursor-row-resize bg-transparent hover:bg-transparent";
const PDF_THEME: "classic" | "minimal" = "classic";

function buildPreviewText(text: string) {
  const trimmed = text.trim();
  if (trimmed.length <= TTS_PREVIEW_LIMIT) return trimmed;
  return `${trimmed.slice(0, TTS_PREVIEW_LIMIT).replace(/\s+\S*$/, "").trim()}…`;
}

function speakBrowserFallback(text: string, onDone: () => void, onError: (message: string) => void) {
  if (typeof window === "undefined" || !window.speechSynthesis || typeof SpeechSynthesisUtterance === "undefined") {
    onError("Browser speech synthesis is unavailable.");
    return;
  }

  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 0.95;
  utterance.pitch = 1;
  utterance.volume = 1;
  utterance.lang = "en-US";
  utterance.onend = onDone;
  utterance.onerror = () => onError("Browser speech playback failed.");
  window.speechSynthesis.speak(utterance);
}

function sortNotes(notes: Note[], mode: NoteSortMode) {
  const copy = [...notes];

  if (mode === "recent") {
    return copy.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
  }

  return copy.sort((a, b) => {
    const aTitle = (a.title || "Untitled note").trim().toLowerCase();
    const bTitle = (b.title || "Untitled note").trim().toLowerCase();
    const result = aTitle.localeCompare(bTitle);
    return mode === "alpha-asc" ? result : -result;
  });
}

function sanitizePdfFileName(name: string) {
  return name
    .trim()
    .replace(/[^a-zA-Z0-9-_\s]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 64) || "studymind-export";
}

function downloadTextPdf(fileName: string, heading: string, body: string) {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const marginX = 46;
  const marginBottom = 44;
  const contentWidth = pageWidth - marginX * 2;
  const headerHeight = 74;
  const generatedAt = new Date().toLocaleString();
  let y = headerHeight + 18;

  const theme = PDF_THEME === "minimal"
    ? {
        headerBg: [250, 250, 252] as [number, number, number],
        title: [32, 32, 40] as [number, number, number],
        meta: [122, 122, 136] as [number, number, number],
        heading: [44, 44, 58] as [number, number, number],
        body: [26, 26, 32] as [number, number, number],
        divider: [224, 224, 234] as [number, number, number],
      }
    : {
        headerBg: [245, 242, 255] as [number, number, number],
        title: [80, 55, 140] as [number, number, number],
        meta: [100, 100, 120] as [number, number, number],
        heading: [50, 50, 70] as [number, number, number],
        body: [24, 24, 28] as [number, number, number],
        divider: [212, 198, 242] as [number, number, number],
      };

  const isSectionHeading = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.length > 64) return false;
    if (trimmed.endsWith(":")) return true;
    if (trimmed.includes(".") || trimmed.includes("?")) return false;
    return /^[A-Za-z][A-Za-z0-9\s&-]{2,}$/.test(trimmed);
  };

  const isBullet = (line: string) => /^([-*•]|\d+[.)])\s+/.test(line.trim());

  const drawHeader = () => {
    doc.setFillColor(...theme.headerBg);
    doc.rect(0, 0, pageWidth, headerHeight, "F");

    doc.setTextColor(...theme.title);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(16);
    const headingLines = doc.splitTextToSize(heading, contentWidth) as string[];
    doc.text(headingLines, marginX, 30);

    doc.setTextColor(...theme.meta);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.text(`Generated by StudyMind • ${generatedAt}`, marginX, 56);

    doc.setDrawColor(...theme.divider);
    doc.setLineWidth(0.8);
    doc.line(marginX, headerHeight - 6, pageWidth - marginX, headerHeight - 6);
  };

  const ensureSpace = (neededHeight: number) => {
    if (y + neededHeight > pageHeight - marginBottom) {
      doc.addPage();
      drawHeader();
      y = headerHeight + 18;
    }
  };

  drawHeader();
  doc.setTextColor(...theme.body);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(11);

  const normalized = body.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();

    if (!trimmed) {
      y += 8;
      continue;
    }

    if (isSectionHeading(trimmed)) {
      ensureSpace(30);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(12.5);
      doc.setTextColor(...theme.heading);
      doc.text(trimmed, marginX, y);
      y += 9;
      doc.setDrawColor(...theme.divider);
      doc.setLineWidth(0.7);
      doc.line(marginX, y, pageWidth - marginX, y);
      y += 10;
      doc.setFont("helvetica", "normal");
      doc.setFontSize(11);
      doc.setTextColor(...theme.body);
      continue;
    }

    if (isBullet(trimmed)) {
      const bulletText = trimmed.replace(/^([-*•]|\d+[.)])\s+/, "");
      const bulletLines = doc.splitTextToSize(bulletText, contentWidth - 16) as string[];
      const blockHeight = bulletLines.length * 14 + 4;
      ensureSpace(blockHeight);
      doc.text("•", marginX, y);
      doc.text(bulletLines, marginX + 12, y);
      y += blockHeight;
      continue;
    }

    const paragraphLines = doc.splitTextToSize(trimmed, contentWidth) as string[];
    const paragraphHeight = paragraphLines.length * 14 + 4;
    ensureSpace(paragraphHeight);
    doc.text(paragraphLines, marginX, y);
    y += paragraphHeight;
  }

  const totalPages = doc.getNumberOfPages();
  for (let page = 1; page <= totalPages; page += 1) {
    doc.setPage(page);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(...theme.meta);
    doc.text(`Page ${page} of ${totalPages}`, pageWidth / 2, pageHeight - 16, { align: "center" });
  }

  doc.save(`${sanitizePdfFileName(fileName)}.pdf`);
}

export default function Notes() {
  const { user } = useAuth();
  const isMobile = useIsMobile();
  const [notes, setNotes] = useState<Note[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [sortMode, setSortMode] = useState<NoteSortMode>("recent");
  const [tagsSupported, setTagsSupported] = useState(true);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [newTag, setNewTag] = useState("");
  const [saving, setSaving] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [audioStatus, setAudioStatus] = useState<string>("");
  const [playbackSpeed, setPlaybackSpeed] = useState(1);

  // PDF / RAG state
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState("");
  const [ragOpen, setRagOpen] = useState(false);
  const [ragQuestion, setRagQuestion] = useState("");
  const [ragAnswer, setRagAnswer] = useState("");
  const [ragSources, setRagSources] = useState<string[]>([]);
  const [ragLoading, setRagLoading] = useState(false);
  const [summarizing, setSummarizing] = useState(false);
  const [summaryText, setSummaryText] = useState("");
  const [summaryTitle, setSummaryTitle] = useState("Summary");
  const [summaryMode, setSummaryMode] = useState<"standard" | "eli5">("standard");
  const [summaryAnalogy, setSummaryAnalogy] = useState("");
  const [summaryBullets, setSummaryBullets] = useState<string[]>([]);
  const [summaryKeyTerms, setSummaryKeyTerms] = useState<string[]>([]);
  const [summaryVisualFlow, setSummaryVisualFlow] = useState<Array<{ label: string; note: string }>>([]);
  const [eli5Mode, setEli5Mode] = useState(false);
  const [hasChunks, setHasChunks] = useState(false);
  const [panelSizesVertical, setPanelSizesVertical] = useState<number[] | null>(null);
  const [panelSizesHorizontal, setPanelSizesHorizontal] = useState<number[] | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const ttsAbortRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const debounce = useRef<number>();
  const suppressAutosaveRef = useRef(false);
  const panelSizesLoadedRef = useRef(false);

  const load = useCallback(async () => {
    try {
      const { notes: loadedNotes, tagsSupported: nextTagsSupported } = await fetchNotesWithTagSupport();
      setTagsSupported(nextTagsSupported);
      setNotes(loadedNotes);
      if (!loadedNotes.length) {
        suppressAutosaveRef.current = true;
        setActiveId(null);
        setTitle("");
        setContent("");
        setTags([]);
        setNewTag("");
        setHasChunks(false);
        return;
      }

      if (!activeId) {
        void selectNote(sortNotes(loadedNotes, sortMode)[0]);
        return;
      }

      const activeNote = loadedNotes.find((note) => note.id === activeId);
      if (!activeNote) {
        void selectNote(sortNotes(loadedNotes, sortMode)[0]);
      }
    } catch (error: unknown) {
      const message = getErrorMessage(error, "Failed to load notes.");
      toast({ title: "Failed to load notes", description: message, variant: "destructive" });
      return;
    }
  }, [activeId, sortMode]);

  const persistNote = useCallback(async ({
    noteId,
    nextTitle,
    nextContent,
    nextTags,
  }: {
    noteId: string;
    nextTitle: string;
    nextContent: string;
    nextTags: string[];
  }) => {
    const result = await updateNoteWithSchemaFallback({
      noteId,
      title: nextTitle || "Untitled note",
      content: nextContent,
      tags: nextTags,
      tagsSupported,
    });

    setTagsSupported(result.tagsSupported);
    setNotes((prev) =>
      sortNotes(
        prev.map((note) =>
          note.id === noteId
            ? {
                ...note,
                title: nextTitle || "Untitled note",
                content: nextContent,
                tags: result.tagsSupported ? nextTags : [],
                updated_at: new Date().toISOString(),
              }
            : note
        ),
        sortMode,
      )
    );

    if (!result.tagsSupported && nextTags.length > 0) {
      setTags([]);
    }

    return result;
  }, [sortMode, tagsSupported]);

  useEffect(() => {
    // Load saved panel sizes from localStorage once on mount
    if (panelSizesLoadedRef.current) return;

    let verticalSizes: number[] | null = null;
    let horizontalSizes: number[] | null = null;

    try {
      const savedVertical = window.localStorage.getItem("studymind.notes-panel-sizes-vertical");
      if (savedVertical) {
        const sizes = JSON.parse(savedVertical) as number[];
        if (Array.isArray(sizes) && sizes.length === 1) {
          verticalSizes = sizes;
        }
      }

      const savedHorizontal = window.localStorage.getItem("studymind.notes-panel-sizes-horizontal");
      if (savedHorizontal) {
        const sizes = JSON.parse(savedHorizontal) as number[];
        if (Array.isArray(sizes) && sizes.length === 2) {
          horizontalSizes = sizes;
        }
      }
    } catch {
      // Ignore parse errors
    }

    // Use defaults if no saved state
    setPanelSizesVertical(verticalSizes || [42]);
    setPanelSizesHorizontal(horizontalSizes || [22, 78]);
    panelSizesLoadedRef.current = true;
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => () => {
    ttsAbortRef.current?.abort();
    audioRef.current?.pause();
    window.speechSynthesis?.cancel();
    if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
  }, []);

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.playbackRate = playbackSpeed;
    }
  }, [playbackSpeed]);

  const selectNote = async (n: Note) => {
    suppressAutosaveRef.current = true;
    setActiveId(n.id);
    setTitle(n.title);
    setContent(n.content);
    setTags(n.tags || []);
    setNewTag("");
    setRagOpen(false);
    setRagAnswer("");
    setRagSources([]);
    setSummaryText("");
    setSummaryAnalogy("");
    setSummaryBullets([]);
    setSummaryKeyTerms([]);
    setSummaryVisualFlow([]);

    // Check if this note has chunks
    const documentChunksClient = supabase as unknown as DocumentChunksLookup;
    const { count } = await documentChunksClient
      .from("document_chunks")
      .select("id", { count: "exact", head: true })
      .eq("note_id", n.id);
    setHasChunks((count ?? 0) > 0);
    window.setTimeout(() => {
      suppressAutosaveRef.current = false;
    }, 0);
  };

  const handleVerticalPanelLayout = (sizes: number[]) => {
    setPanelSizesVertical(sizes);
    try {
      window.localStorage.setItem("studymind.notes-panel-sizes-vertical", JSON.stringify(sizes));
    } catch {
      // Ignore storage errors
    }
  };

  const handleHorizontalPanelLayout = (sizes: number[]) => {
    setPanelSizesHorizontal(sizes);
    try {
      window.localStorage.setItem("studymind.notes-panel-sizes-horizontal", JSON.stringify(sizes));
    } catch {
      // Ignore storage errors
    }
  };

  const newNote = async () => {
    if (!user?.id) {
      toast({ title: "Error", description: "User not authenticated. Please log in.", variant: "destructive" });
      return;
    }
    const { data, error } = await supabase
      .from("notes")
      .insert({ user_id: user.id, title: "Untitled note", content: "" })
      .select()
      .single();
    if (error) return toast({ title: "Error", description: error.message, variant: "destructive" });
    await trackActivity(user.id);
    await load();
    selectNote({ ...data, tags: [] });
  };

  const remove = async (id: string) => {
    await supabase.from("notes").delete().eq("id", id);
    if (activeId === id) { setActiveId(null); setTitle(""); setContent(""); setHasChunks(false); }
    await load();
  };

  // autosave
  useEffect(() => {
    if (!activeId || !user?.id) return;
    if (suppressAutosaveRef.current) {
      suppressAutosaveRef.current = false;
      return;
    }
    window.clearTimeout(debounce.current);
    debounce.current = window.setTimeout(async () => {
      try {
        setSaving(true);
        await persistNote({
          noteId: activeId,
          nextTitle: title || "Untitled note",
          nextContent: content,
          nextTags: tags,
        });
        await trackActivity(user.id);
      } catch (error: unknown) {
        const message = getErrorMessage(error, "Could not save the note.");
        toast({ title: "Save failed", description: message, variant: "destructive" });
      } finally {
        setSaving(false);
      }
    }, 600);
    return () => window.clearTimeout(debounce.current);
  }, [title, content, tags, activeId, user?.id, persistNote]);

  const speak = async () => {
    if (!content.trim()) return;
    try {
      ttsAbortRef.current?.abort();
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.currentTime = 0;
      }
      if (audioUrlRef.current) {
        URL.revokeObjectURL(audioUrlRef.current);
        setAudioUrl(null);
        audioUrlRef.current = null;
      }
      setAudioStatus("Generating audio...");

      setSpeaking(true);
      const controller = new AbortController();
      ttsAbortRef.current = controller;
      const input = buildPreviewText(content);
      if (content.trim().length > TTS_PREVIEW_LIMIT) {
        toast({ title: "Reading preview", description: "For long notes, playback uses a shorter preview so audio starts faster." });
      }
      const blob = await ttsToBlob(input, "sarah", controller.signal, 1);
      const url = URL.createObjectURL(blob);
      audioUrlRef.current = url;
      setAudioUrl(url);
      setAudioStatus("Playing audio...");
      const audio = new Audio(url);
      audio.preload = "auto";
      audio.volume = 1;
      audio.playbackRate = playbackSpeed;
      audioRef.current = audio;
      ttsAbortRef.current = null;
      const fallbackTimer = window.setTimeout(() => {
        setAudioStatus("Audio is ready. Use the player controls below if it does not auto-start.");
      }, 1800);

      audio.onplaying = () => {
        window.clearTimeout(fallbackTimer);
        setAudioStatus("Playing audio...");
      };
      audio.onended = () => {
        window.clearTimeout(fallbackTimer);
        setSpeaking(false);
        setAudioStatus("Playback finished.");
      };
      audio.onerror = () => {
        window.clearTimeout(fallbackTimer);
        setSpeaking(false);
        setAudioStatus("Audio could not start automatically. Use the player controls below.");
        toast({ title: "TTS warning", description: "Audio was generated, but the browser player did not start automatically. Use the controls below.", variant: "default" });
      };
      audio.load();
      void audio.play().catch(() => {
        setAudioStatus("Audio is ready. Use the player controls below to start playback.");
      });
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      const message = error instanceof Error ? error.message : "Audio playback failed.";
      setSpeaking(false);
      toast({ title: "TTS error", description: message, variant: "destructive" });
    }
  };

  const stopSpeak = () => {
    ttsAbortRef.current?.abort();
    ttsAbortRef.current = null;
    window.speechSynthesis?.cancel();
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      setAudioUrl(null);
      audioUrlRef.current = null;
    }
    setAudioStatus("Playback stopped.");
    setSpeaking(false);
  };

  // ── PDF Upload ────────────────────────────────────────────────────────────

  const handlePdfSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !activeId || !user) return;
    e.target.value = ""; // reset so same file can be re-selected

    setUploading(true);
    setUploadMsg("Extracting text from PDF…");
    try {
      const { text, chunks } = await uploadPdf(
        file,
        user.id,
        activeId,
        setUploadMsg,
      );

      // Fill note title + content from PDF
      const pdfTitle = file.name.replace(/\.pdf$/i, "");
      window.clearTimeout(debounce.current);
      setSaving(true);
      suppressAutosaveRef.current = true;
      setTitle(pdfTitle);
      setContent(text);
      setHasChunks(true);
      setSummaryText("");
      setSummaryAnalogy("");
      setSummaryBullets([]);
      setSummaryKeyTerms([]);
      setSummaryVisualFlow([]);
      await persistNote({
        noteId: activeId,
        nextTitle: pdfTitle,
        nextContent: text,
        nextTags: tags,
      });
      await trackActivity(user.id);

      toast({
        title: "PDF processed",
        description: `${chunks} chunks embedded and note text saved for future use.`,
      });
    } catch (error: unknown) {
      const message = getErrorMessage(error, "Upload failed.");
      toast({ title: "Upload failed", description: message, variant: "destructive" });
    } finally {
      setSaving(false);
      setUploading(false);
      setUploadMsg("");
    }
  };

  const summarizeCurrentNote = async () => {
    if (!content.trim()) return;
    setSummarizing(true);
    try {
      const result = await summarizeNote(content, 8, eli5Mode ? "eli5" : "standard");
      setSummaryMode(result.mode);
      setSummaryTitle(result.title || (eli5Mode ? "ELI5 Summary" : "Summary"));
      setSummaryAnalogy(result.analogy || "");
      setSummaryBullets(result.bullets || []);
      setSummaryKeyTerms(result.key_terms || []);
      const fallbackFlow = (result.bullets || []).slice(0, 4).map((point, idx) => ({
        label: `Step ${idx + 1}`,
        note: point,
      }));
      setSummaryVisualFlow((result.visual_flow && result.visual_flow.length > 0) ? result.visual_flow : fallbackFlow);
      const summary = result.summary;
      setSummaryText(summary);
      toast({ title: "Summary ready", description: eli5Mode ? "SImiplified Analsysis is ready" : "Your PDF summary is generated." });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Summary failed.";
      toast({ title: "Summary failed", description: message, variant: "destructive" });
    } finally {
      setSummarizing(false);
    }
  };

  const insertSummaryIntoNote = () => {
    if (!summaryText.trim()) return;
    const summaryBlock = `Summary\n${summaryText}\n\n`;
    setContent((prev) => `${summaryBlock}${prev}`);
    toast({ title: "Summary inserted", description: "Added summary to the top of your note." });
  };

  const buildSummaryPdfBody = () => [
    summaryText,
    summaryMode === "eli5" && summaryAnalogy ? `Simple analogy\n${summaryAnalogy}` : "",
    summaryMode === "eli5" && summaryBullets.length > 0
      ? `Key ideas\n${summaryBullets.map((point, i) => `${i + 1}. ${point}`).join("\n")}`
      : "",
    summaryMode === "eli5" && summaryVisualFlow.length > 0
      ? `Visual concept flow\n${summaryVisualFlow.map((step, i) => `${i + 1}. ${step.label}${step.note ? `: ${step.note}` : ""}`).join("\n")}`
      : "",
    summaryMode === "eli5" && summaryKeyTerms.length > 0
      ? `Key terms\n${summaryKeyTerms.join(", ")}`
      : "",
  ].filter(Boolean).join("\n\n");

  const downloadPdf = () => {
    const baseTitle = (title || "Untitled note").trim();

    if (summaryText.trim()) {
      if (summaryMode === "eli5") {
        downloadTextPdf(`${baseTitle}-simplified-analysis`, `Simplified Analysis - ${baseTitle}`, buildSummaryPdfBody());
        toast({ title: "PDF downloaded", description: "Your simplified analysis PDF has been downloaded." });
        return;
      }

      downloadTextPdf(`${baseTitle}-summary`, `${summaryTitle || "Summary"} - ${baseTitle}`, buildSummaryPdfBody());
      toast({ title: "PDF downloaded", description: "Your summary PDF has been downloaded." });
      return;
    }

    if (!content.trim()) {
      toast({ title: "Nothing to export", description: "Add note content or generate a summary before downloading.", variant: "destructive" });
      return;
    }

    downloadTextPdf(`${baseTitle}-note`, baseTitle, content);
    toast({ title: "PDF downloaded", description: "Your note PDF has been downloaded." });
  };

  // ── RAG Query ─────────────────────────────────────────────────────────────

  const askRag = async () => {
    if (!ragQuestion.trim() || !activeId || !user) return;
    setRagLoading(true);
    setRagAnswer("");
    setRagSources([]);
    try {
      const { answer, sources } = await queryRag(ragQuestion, activeId, user.id);
      setRagAnswer(answer);
      setRagSources(sources);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Query failed.";
      toast({
        title: "Query failed",
        description: message,
        variant: "destructive",
      });
    } finally {
      setRagLoading(false);
    }
  };

  const visibleNotes = useMemo(() => sortNotes(notes, sortMode), [notes, sortMode]);
  const showRagPanel = ragOpen && hasChunks;

  return (
    <div className="min-h-full lg:h-full">
      {isMobile ? (
        // Mobile: Stacked layout
        <div className="flex flex-col min-h-full">
      {/* ── Sidebar ── */}
      <div className="w-full border-b border-border bg-card/50 flex flex-col">
        <div className="p-4 border-b border-border space-y-3">
          <Button
            onClick={newNote}
            className="w-full bg-gradient-primary text-primary-foreground hover:opacity-90 shadow-soft"
          >
            <Plus className="h-4 w-4 mr-2" /> New note
          </Button>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground whitespace-nowrap">Sort</span>
            <select
              value={sortMode}
              onChange={(e) => setSortMode(e.target.value as NoteSortMode)}
              className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
            >
              <option value="recent">Most recent</option>
              <option value="alpha-asc">A-Z</option>
              <option value="alpha-desc">Z-A</option>
            </select>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto overflow-x-hidden p-2 space-y-1 scrollbar-hide">
          {notes.length === 0 && (
            <p className="text-center text-sm text-muted-foreground p-6">
              No notes yet. Create your first one!
            </p>
          )}
          {visibleNotes.map((n) => (
            <button
              key={n.id}
              onClick={() => selectNote(n)}
              className={cn(
                "w-full text-left p-3 rounded-lg group transition-colors",
                activeId === n.id ? "bg-secondary" : "hover:bg-secondary/60",
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-medium text-sm whitespace-normal break-words">{n.title || "Untitled"}</div>
                  <div className="text-xs text-muted-foreground whitespace-normal break-words mt-0.5">
                    {n.content.slice(0, 60) || "Empty"}
                  </div>
                </div>
                <span
                  role="button"
                  aria-label="Delete note"
                  onClick={(e) => { e.stopPropagation(); remove(n.id); }}
                  className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-destructive/10 cursor-pointer"
                >
                  <Trash2 className="h-3.5 w-3.5 text-destructive" />
                </span>
              </div>
            </button>
          ))}
        </div>
      </div>

        {/* ── Editor ── */}
        <div className="flex-1 flex flex-col min-w-0">
        {activeId ? (
          <>
            {/* Title bar */}
            <div className="border-b border-border p-3 sm:p-4 flex items-center gap-2">
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Note title"
                className="border-0 text-base sm:text-lg font-display font-semibold focus-visible:ring-0 px-0"
              />
              <div className="text-xs text-muted-foreground whitespace-nowrap">
                {saving ? "Saving…" : "Saved"}
              </div>
            </div>

            {tagsSupported && (
              <div className="border-b border-border p-3 sm:p-4 bg-secondary/20 space-y-2">
                <div className="flex items-center gap-2 flex-wrap">
                  {tags.map((tag) => (
                    <div key={tag} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-primary text-primary-foreground text-xs font-medium">
                      {tag}
                      <button
                        onClick={() => setTags(tags.filter((t) => t !== tag))}
                        className="hover:opacity-70 transition-opacity ml-1"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
                <div className="flex items-center gap-2 max-w-sm">
                  <Input
                    value={newTag}
                    onChange={(e) => setNewTag(e.target.value.trim())}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && newTag && !tags.includes(newTag)) {
                        setTags([...tags, newTag]);
                        setNewTag("");
                      }
                    }}
                    placeholder="Add tag (press Enter)"
                    className="h-8 text-xs"
                  />
                </div>
              </div>
            )}

            {/* Toolbar */}
            <div className="p-3 sm:p-4 border-b border-border flex flex-wrap gap-2">
              {/* TTS */}
              {!speaking ? (
                <Button size="sm" variant="secondary" onClick={speak} disabled={!content.trim()}>
                  <Volume2 className="h-4 w-4 mr-2" /> Listen
                </Button>
              ) : (
                <Button size="sm" variant="destructive" onClick={stopSpeak}>
                  <X className="h-4 w-4 mr-2" /> Stop
                </Button>
              )}
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>Speed</span>
                <select
                  value={playbackSpeed}
                  onChange={(e) => setPlaybackSpeed(Number(e.target.value))}
                  className="h-9 rounded-md border border-border bg-background px-2 text-sm"
                >
                  {TTS_SPEED_OPTIONS.map((speed) => (
                    <option key={speed} value={speed}>
                      {speed.toFixed(2)}x
                    </option>
                  ))}
                </select>
              </div>

              {/* PDF upload */}
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf"
                className="hidden"
                onChange={handlePdfSelect}
              />
              <Button
                size="sm"
                variant="secondary"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
              >
                {uploading
                  ? <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  : <Upload className="h-4 w-4 mr-2" />}
                {uploading ? uploadMsg || "Processing…" : "Upload PDF"}
              </Button>

              <Button
                size="sm"
                variant="secondary"
                onClick={summarizeCurrentNote}
                disabled={summarizing || !content.trim()}
              >
                {summarizing
                  ? <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  : <FileText className="h-4 w-4 mr-2" />}
                {summarizing ? "Summarizing…" : "Summarize PDF"}
              </Button>

              <Button
                size="sm"
                variant={eli5Mode ? "default" : "secondary"}
                onClick={() => setEli5Mode((v) => !v)}
                className={eli5Mode ? "bg-gradient-primary text-primary-foreground" : ""}
              >
                <FileText className="h-4 w-4 mr-2" />
                Simplified Analysis {eli5Mode ? "ON" : "OFF"}
              </Button>

              {/* Ask about this doc — only shown once PDF is embedded */}
              {hasChunks && (
                <Button
                  size="sm"
                  variant={ragOpen ? "default" : "secondary"}
                  onClick={() => setRagOpen((o) => !o)}
                  className={ragOpen ? "bg-gradient-primary text-primary-foreground" : ""}
                >
                  <BookOpen className="h-4 w-4 mr-2" />
                  Ask this doc
                </Button>
              )}

              <Button size="sm" variant="outline" onClick={downloadPdf} className="ml-auto" disabled={!content.trim() && !summaryText.trim()}>
                <Download className="h-4 w-4 mr-2" />
                Download PDF
              </Button>
            </div>

            {audioUrl && (
              <div className="border-b border-border px-3 sm:px-4 py-3">
                <div className="rounded-lg border border-border bg-background/60 p-3 space-y-2 max-w-full overflow-hidden">
                  <div className="text-xs text-muted-foreground">
                    {audioStatus || "Audio is ready."}
                  </div>
                  <audio
                    key={audioUrl}
                    controls
                    src={audioUrl}
                    autoPlay
                    className="w-full max-w-full"
                    onLoadedMetadata={(e) => {
                      e.currentTarget.playbackRate = playbackSpeed;
                    }}
                    onPlay={(e) => {
                      e.currentTarget.playbackRate = playbackSpeed;
                      setSpeaking(true);
                    }}
                    onPause={() => setSpeaking(false)}
                    onEnded={() => {
                      setSpeaking(false);
                      setAudioStatus("Playback finished.");
                    }}
                    onError={() => {
                      setSpeaking(false);
                      setAudioStatus("The browser could not play this audio file.");
                    }}
                  />
                </div>
              </div>
            )}

            {summaryText && showRagPanel && (
              <div className="border-b border-border p-3 sm:p-4 bg-secondary/20 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium text-primary">{summaryTitle || "Summary"}</p>
                  <div className="flex items-center gap-2">
                    <Button size="sm" variant="secondary" onClick={insertSummaryIntoNote}>Insert into note</Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setSummaryText("");
                        setSummaryAnalogy("");
                        setSummaryBullets([]);
                        setSummaryKeyTerms([]);
                        setSummaryVisualFlow([]);
                      }}
                    >
                      Dismiss
                    </Button>
                  </div>
                </div>
                <Card className="p-3 text-sm whitespace-pre-wrap leading-relaxed">
                  {summaryText}
                </Card>

                {summaryMode === "eli5" && summaryAnalogy && (
                  <Card className="p-3 text-sm">
                    <p className="font-medium text-primary mb-1">Simple analogy</p>
                    <p className="text-muted-foreground">{summaryAnalogy}</p>
                  </Card>
                )}

                {summaryMode === "eli5" && summaryBullets.length > 0 && (
                  <Card className="p-3 text-sm">
                    <p className="font-medium text-primary mb-2">Key ideas</p>
                    <ul className="list-disc pl-5 space-y-1 text-muted-foreground">
                      {summaryBullets.map((point, i) => (
                        <li key={`${point}-${i}`}>{point}</li>
                      ))}
                    </ul>
                  </Card>
                )}

                {summaryMode === "eli5" && summaryVisualFlow.length > 0 && (
                  <Card className="p-3 text-sm">
                    <p className="font-medium text-primary mb-3">Visual concept flow</p>
                    <div className="overflow-x-auto">
                      <div className="flex items-stretch gap-2 min-w-max">
                        {summaryVisualFlow.map((step, i) => (
                          <div key={`${step.label}-${i}`} className="flex items-center gap-2">
                            <div className="w-56 rounded-lg border border-border bg-background/70 p-3">
                              <p className="font-medium text-foreground">{step.label}</p>
                              {step.note && <p className="text-xs text-muted-foreground mt-1">{step.note}</p>}
                            </div>
                            {i < summaryVisualFlow.length - 1 && <ArrowRight className="h-4 w-4 text-muted-foreground" />}
                          </div>
                        ))}
                      </div>
                    </div>
                  </Card>
                )}

                {summaryMode === "eli5" && summaryKeyTerms.length > 0 && (
                  <Card className="p-3 text-sm">
                    <p className="font-medium text-primary mb-2">Key terms</p>
                    <div className="flex flex-wrap gap-2">
                      {summaryKeyTerms.map((term, i) => (
                        <span key={`${term}-${i}`} className="px-2 py-1 rounded-md bg-secondary text-secondary-foreground text-xs">
                          {term}
                        </span>
                      ))}
                    </div>
                  </Card>
                )}
              </div>
            )}

            {summaryText && !showRagPanel ? (
              isMobile ? (
                <div className="flex-1 min-h-0 overflow-auto">
                  <div className="border-b border-border p-3 sm:p-4 bg-secondary/20 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm font-medium text-primary">{summaryTitle || "Summary"}</p>
                      <div className="flex items-center gap-2">
                        <Button size="sm" variant="secondary" onClick={insertSummaryIntoNote}>Insert into note</Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setSummaryText("");
                            setSummaryAnalogy("");
                            setSummaryBullets([]);
                            setSummaryKeyTerms([]);
                            setSummaryVisualFlow([]);
                          }}
                        >
                          Dismiss
                        </Button>
                      </div>
                    </div>

                    <Card className="p-3 text-sm whitespace-pre-wrap leading-relaxed">
                      {summaryText}
                    </Card>

                    {summaryMode === "eli5" && summaryAnalogy && (
                      <Card className="p-3 text-sm">
                        <p className="font-medium text-primary mb-1">Simple analogy</p>
                        <p className="text-muted-foreground">{summaryAnalogy}</p>
                      </Card>
                    )}

                    {summaryMode === "eli5" && summaryBullets.length > 0 && (
                      <Card className="p-3 text-sm">
                        <p className="font-medium text-primary mb-2">Key ideas</p>
                        <ul className="list-disc pl-5 space-y-1 text-muted-foreground">
                          {summaryBullets.map((point, i) => (
                            <li key={`${point}-${i}`}>{point}</li>
                          ))}
                        </ul>
                      </Card>
                    )}

                    {summaryMode === "eli5" && summaryVisualFlow.length > 0 && (
                      <Card className="p-3 text-sm">
                        <p className="font-medium text-primary mb-3">Visual concept flow</p>
                        <div className="space-y-2">
                          {summaryVisualFlow.map((step, i) => (
                            <div key={`${step.label}-${i}`} className="rounded-lg border border-border bg-background/70 p-3">
                              <p className="font-medium text-foreground">{step.label}</p>
                              {step.note && <p className="text-xs text-muted-foreground mt-1">{step.note}</p>}
                            </div>
                          ))}
                        </div>
                      </Card>
                    )}

                    {summaryMode === "eli5" && summaryKeyTerms.length > 0 && (
                      <Card className="p-3 text-sm">
                        <p className="font-medium text-primary mb-2">Key terms</p>
                        <div className="flex flex-wrap gap-2">
                          {summaryKeyTerms.map((term, i) => (
                            <span key={`${term}-${i}`} className="px-2 py-1 rounded-md bg-secondary text-secondary-foreground text-xs">
                              {term}
                            </span>
                          ))}
                        </div>
                      </Card>
                    )}
                  </div>

                  <Textarea
                    value={content}
                    onChange={(e) => setContent(e.target.value)}
                    placeholder="Start typing, paste study material, upload a PDF, or use the mic…"
                    className="min-h-[45vh] resize-none border-0 focus-visible:ring-0 rounded-none p-4 text-sm leading-relaxed font-sans"
                  />
                </div>
              ) : (
              <div className="flex-1 min-h-0">
                {panelSizesVertical && (
                <ResizablePanelGroup direction="vertical" className="h-full" onLayout={handleVerticalPanelLayout}>
                  <ResizablePanel defaultSize={panelSizesVertical[0]} key={`top-${panelSizesVertical[0]}`} minSize={24} maxSize={70} className="min-h-0 overflow-hidden">
                    <div className="h-full border-b border-border p-3 sm:p-4 bg-secondary/20 space-y-3 overflow-y-auto overflow-x-hidden scrollbar-hide">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-sm font-medium text-primary">{summaryTitle || "Summary"}</p>
                        <div className="flex items-center gap-2">
                          <Button size="sm" variant="secondary" onClick={insertSummaryIntoNote}>Insert into note</Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              setSummaryText("");
                              setSummaryAnalogy("");
                              setSummaryBullets([]);
                              setSummaryKeyTerms([]);
                              setSummaryVisualFlow([]);
                            }}
                          >
                            Dismiss
                          </Button>
                        </div>
                      </div>
                      <Card className="p-3 text-sm whitespace-pre-wrap leading-relaxed">
                        {summaryText}
                      </Card>

                      {summaryMode === "eli5" && summaryAnalogy && (
                        <Card className="p-3 text-sm">
                          <p className="font-medium text-primary mb-1">Simple analogy</p>
                          <p className="text-muted-foreground">{summaryAnalogy}</p>
                        </Card>
                      )}

                      {summaryMode === "eli5" && summaryBullets.length > 0 && (
                        <Card className="p-3 text-sm">
                          <p className="font-medium text-primary mb-2">Key ideas</p>
                          <ul className="list-disc pl-5 space-y-1 text-muted-foreground">
                            {summaryBullets.map((point, i) => (
                              <li key={`${point}-${i}`}>{point}</li>
                            ))}
                          </ul>
                        </Card>
                      )}

                      {summaryMode === "eli5" && summaryVisualFlow.length > 0 && (
                        <Card className="p-3 text-sm">
                          <p className="font-medium text-primary mb-3">Visual concept flow</p>
                          <div className="overflow-x-auto">
                            <div className="flex items-stretch gap-2 min-w-max">
                              {summaryVisualFlow.map((step, i) => (
                                <div key={`${step.label}-${i}`} className="flex items-center gap-2">
                                  <div className="w-56 rounded-lg border border-border bg-background/70 p-3">
                                    <p className="font-medium text-foreground">{step.label}</p>
                                    {step.note && <p className="text-xs text-muted-foreground mt-1">{step.note}</p>}
                                  </div>
                                  {i < summaryVisualFlow.length - 1 && <ArrowRight className="h-4 w-4 text-muted-foreground" />}
                                </div>
                              ))}
                            </div>
                          </div>
                        </Card>
                      )}

                      {summaryMode === "eli5" && summaryKeyTerms.length > 0 && (
                        <Card className="p-3 text-sm">
                          <p className="font-medium text-primary mb-2">Key terms</p>
                          <div className="flex flex-wrap gap-2">
                            {summaryKeyTerms.map((term, i) => (
                              <span key={`${term}-${i}`} className="px-2 py-1 rounded-md bg-secondary text-secondary-foreground text-xs">
                                {term}
                              </span>
                            ))}
                          </div>
                        </Card>
                      )}
                    </div>
                  </ResizablePanel>

                  <ResizableHandle
                    className={cn(
                      INVISIBLE_VERTICAL_RESIZE_HANDLE,
                      isMobile && "hidden",
                    )}
                  />

                  <ResizablePanel minSize={30} className="min-h-0">
                    <Textarea
                      value={content}
                      onChange={(e) => setContent(e.target.value)}
                      placeholder="Start typing, paste study material, upload a PDF, or use the mic…"
                      className="h-full resize-none border-0 focus-visible:ring-0 rounded-none p-4 sm:p-6 text-sm sm:text-base leading-relaxed font-sans"
                    />
                  </ResizablePanel>
                </ResizablePanelGroup>
                )}
              </div>
              )
            ) : showRagPanel ? (
              isMobile ? (
                <div className="flex-1 min-h-0 overflow-auto">
                  <div className="border-b border-border p-3 sm:p-4 bg-secondary/30 space-y-3">
                    <div className="flex items-center gap-2">
                      <Input
                        value={ragQuestion}
                        onChange={(e) => setRagQuestion(e.target.value)}
                        placeholder="Ask anything about this document…"
                        onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && askRag()}
                        className="flex-1"
                      />
                      <Button size="sm" onClick={askRag} disabled={ragLoading || !ragQuestion.trim()}>
                        {ragLoading
                          ? <Loader2 className="h-4 w-4 animate-spin" />
                          : <Send className="h-4 w-4" />}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => { setRagOpen(false); setRagAnswer(""); setRagSources([]); }}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>

                    {ragAnswer && (
                      <Card className="p-3 text-sm space-y-2">
                        <p className="font-medium text-primary">Answer</p>
                        <p className="leading-relaxed whitespace-pre-wrap">{ragAnswer}</p>
                        {ragSources.length > 0 && (
                          <details className="text-xs text-muted-foreground">
                            <summary className="cursor-pointer hover:text-foreground transition-colors">
                              {ragSources.length} source chunk{ragSources.length > 1 ? "s" : ""}
                            </summary>
                            <div className="mt-2 space-y-2">
                              {ragSources.map((s, i) => (
                                <p key={i} className="border-l-2 border-border pl-2 line-clamp-3">{s}</p>
                              ))}
                            </div>
                          </details>
                        )}
                      </Card>
                    )}
                  </div>

                  <Textarea
                    value={content}
                    onChange={(e) => setContent(e.target.value)}
                    placeholder="Start typing, paste study material, upload a PDF, or use the mic…"
                    className="min-h-[45vh] resize-none border-0 focus-visible:ring-0 rounded-none p-4 text-sm leading-relaxed font-sans"
                  />
                </div>
              ) : (
              <div className="flex-1 min-h-0">
                {panelSizesVertical && (
                <ResizablePanelGroup direction="vertical" className="h-full" onLayout={handleVerticalPanelLayout}>
                  <ResizablePanel defaultSize={panelSizesVertical[0]} key={`top2-${panelSizesVertical[0]}`} minSize={25} maxSize={70} className="min-h-0 overflow-hidden">
                    <div className="h-full border-b border-border p-3 sm:p-4 bg-secondary/30 space-y-3 overflow-y-auto overflow-x-hidden scrollbar-hide">
                      <div className="flex items-center gap-2">
                        <Input
                          value={ragQuestion}
                          onChange={(e) => setRagQuestion(e.target.value)}
                          placeholder="Ask anything about this document…"
                          onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && askRag()}
                          className="flex-1"
                        />
                        <Button size="sm" onClick={askRag} disabled={ragLoading || !ragQuestion.trim()}>
                          {ragLoading
                            ? <Loader2 className="h-4 w-4 animate-spin" />
                            : <Send className="h-4 w-4" />}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => { setRagOpen(false); setRagAnswer(""); setRagSources([]); }}
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      </div>

                      {ragAnswer && (
                        <Card className="p-3 text-sm space-y-2">
                          <p className="font-medium text-primary">Answer</p>
                          <p className="leading-relaxed whitespace-pre-wrap">{ragAnswer}</p>
                          {ragSources.length > 0 && (
                            <details className="text-xs text-muted-foreground">
                              <summary className="cursor-pointer hover:text-foreground transition-colors">
                                {ragSources.length} source chunk{ragSources.length > 1 ? "s" : ""}
                              </summary>
                              <div className="mt-2 space-y-2">
                                {ragSources.map((s, i) => (
                                  <p key={i} className="border-l-2 border-border pl-2 line-clamp-3">{s}</p>
                                ))}
                              </div>
                            </details>
                          )}
                        </Card>
                      )}
                    </div>
                  </ResizablePanel>

                  <ResizableHandle
                    className={cn(
                      INVISIBLE_VERTICAL_RESIZE_HANDLE,
                      isMobile && "hidden",
                    )}
                  />

                  <ResizablePanel minSize={30} className="min-h-0">
                    <Textarea
                      value={content}
                      onChange={(e) => setContent(e.target.value)}
                      placeholder="Start typing, paste study material, upload a PDF, or use the mic…"
                      className="h-full resize-none border-0 focus-visible:ring-0 rounded-none p-4 sm:p-6 text-sm sm:text-base leading-relaxed font-sans"
                    />
                  </ResizablePanel>
                </ResizablePanelGroup>
                )}
              </div>
              )
            ) : (
              <Textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="Start typing, paste study material, upload a PDF, or use the mic…"
                className={cn(
                  "resize-none border-0 focus-visible:ring-0 rounded-none p-4 sm:p-6 text-sm sm:text-base leading-relaxed font-sans",
                  isMobile ? "min-h-[45vh]" : "flex-1",
                )}
              />
            )}
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-center p-10">
            <div>
              <div className="h-16 w-16 mx-auto rounded-2xl bg-secondary flex items-center justify-center mb-4">
                <FileText className="h-8 w-8 text-primary" />
              </div>
              <h2 className="font-display text-xl font-semibold">No note selected</h2>
              <p className="text-muted-foreground mt-2">Create a note or upload a PDF to get started.</p>
              <Button onClick={newNote} className="mt-4 bg-gradient-primary text-primary-foreground">
                <Plus className="h-4 w-4 mr-2" /> New note
              </Button>
            </div>
          </div>
        )}
      </div>
        </div>
      ) : (
        // Desktop: Resizable horizontal layout
        panelSizesHorizontal ? (
        <ResizablePanelGroup direction="horizontal" className="w-full h-full" onLayout={handleHorizontalPanelLayout}>
          {/* ── Sidebar Panel ── */}
          <ResizablePanel defaultSize={panelSizesHorizontal[0]} key={`left-${panelSizesHorizontal[0]}`} minSize={18} maxSize={35} className="min-w-0">
            <div className="w-full h-full bg-card/50 flex flex-col border-r border-border">
              <div className="p-4 border-b border-border space-y-3">
                <Button
                  onClick={newNote}
                  className="w-full bg-gradient-primary text-primary-foreground hover:opacity-90 shadow-soft"
                >
                  <Plus className="h-4 w-4 mr-2" /> New note
                </Button>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground whitespace-nowrap">Sort</span>
                  <select
                    value={sortMode}
                    onChange={(e) => setSortMode(e.target.value as NoteSortMode)}
                    className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
                  >
                    <option value="recent">Most recent</option>
                    <option value="alpha-asc">A-Z</option>
                    <option value="alpha-desc">Z-A</option>
                  </select>
                </div>
              </div>
              <div className="flex-1 overflow-y-auto p-2 space-y-1 scrollbar-hide">
                {notes.length === 0 && (
                  <p className="text-center text-sm text-muted-foreground p-6">
                    No notes yet. Create your first one!
                  </p>
                )}
                {visibleNotes.map((n) => (
                  <button
                    key={n.id}
                    onClick={() => selectNote(n)}
                    className={cn(
                      "w-full text-left p-3 rounded-lg group transition-colors",
                      activeId === n.id ? "bg-secondary" : "hover:bg-secondary/60",
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="font-medium text-sm whitespace-normal break-words">{n.title || "Untitled"}</div>
                        <div className="text-xs text-muted-foreground whitespace-normal break-words mt-0.5">
                          {n.content.slice(0, 60) || "Empty"}
                        </div>
                      </div>
                      <span
                        role="button"
                        aria-label="Delete note"
                        onClick={(e) => { e.stopPropagation(); remove(n.id); }}
                        className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-destructive/10 cursor-pointer"
                      >
                        <Trash2 className="h-3.5 w-3.5 text-destructive" />
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </ResizablePanel>

          <ResizableHandle className={INVISIBLE_HORIZONTAL_RESIZE_HANDLE} />

          {/* ── Editor Panel ── */}
          <ResizablePanel defaultSize={panelSizesHorizontal[1]} key={`right-${panelSizesHorizontal[1]}`} minSize={65} className="min-w-0 flex flex-col">
            {activeId ? (
              <>
                {/* Title bar */}
                <div className="border-b border-border p-3 sm:p-4 flex items-center gap-2">
                  <Input
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="Note title"
                    className="border-0 text-base sm:text-lg font-display font-semibold focus-visible:ring-0 px-0"
                  />
                  <div className="text-xs text-muted-foreground whitespace-nowrap">
                    {saving ? "Saving…" : "Saved"}
                  </div>
                </div>

                {tagsSupported && (
                  <div className="border-b border-border p-3 sm:p-4 bg-secondary/20 space-y-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      {tags.map((tag) => (
                        <div key={tag} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-primary text-primary-foreground text-xs font-medium">
                          {tag}
                          <button
                            onClick={() => setTags(tags.filter((t) => t !== tag))}
                            className="hover:opacity-70 transition-opacity ml-1"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </div>
                      ))}
                    </div>
                    <div className="flex items-center gap-2 max-w-sm">
                      <Input
                        value={newTag}
                        onChange={(e) => setNewTag(e.target.value.trim())}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && newTag && !tags.includes(newTag)) {
                            setTags([...tags, newTag]);
                            setNewTag("");
                          }
                        }}
                        placeholder="Add tag (press Enter)"
                        className="h-8 text-xs"
                      />
                    </div>
                  </div>
                )}

                {/* Toolbar */}
                <div className="p-3 sm:p-4 border-b border-border flex flex-wrap gap-2">
                  {/* TTS */}
                  {!speaking ? (
                    <Button size="sm" variant="secondary" onClick={speak} disabled={!content.trim()}>
                      <Volume2 className="h-4 w-4 mr-2" /> Listen
                    </Button>
                  ) : (
                    <Button size="sm" variant="destructive" onClick={stopSpeak}>
                      <X className="h-4 w-4 mr-2" /> Stop
                    </Button>
                  )}
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span>Speed</span>
                    <select
                      value={playbackSpeed}
                      onChange={(e) => setPlaybackSpeed(Number(e.target.value))}
                      className="h-9 rounded-md border border-border bg-background px-2 text-sm"
                    >
                      {TTS_SPEED_OPTIONS.map((speed) => (
                        <option key={speed} value={speed}>
                          {speed.toFixed(2)}x
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* PDF upload */}
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".pdf"
                    className="hidden"
                    onChange={handlePdfSelect}
                  />
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploading}
                  >
                    {uploading
                      ? <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      : <Upload className="h-4 w-4 mr-2" />}
                    {uploading ? uploadMsg || "Processing…" : "Upload PDF"}
                  </Button>

                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={summarizeCurrentNote}
                    disabled={summarizing || !content.trim()}
                  >
                    {summarizing
                      ? <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      : <FileText className="h-4 w-4 mr-2" />}
                    {summarizing ? "Summarizing…" : "Summarize PDF"}
                  </Button>

                  <Button
                    size="sm"
                    variant={eli5Mode ? "default" : "secondary"}
                    onClick={() => setEli5Mode((v) => !v)}
                    className={eli5Mode ? "bg-gradient-primary text-primary-foreground" : ""}
                  >
                    <FileText className="h-4 w-4 mr-2" />
                    Simplified Analysis {eli5Mode ? "ON" : "OFF"}
                  </Button>

                  {/* Ask about this doc — only shown once PDF is embedded */}
                  {hasChunks && (
                    <Button
                      size="sm"
                      variant={ragOpen ? "default" : "secondary"}
                      onClick={() => setRagOpen((o) => !o)}
                      className={ragOpen ? "bg-gradient-primary text-primary-foreground" : ""}
                    >
                      <BookOpen className="h-4 w-4 mr-2" />
                      Ask this doc
                    </Button>
                  )}

                  <Button size="sm" variant="outline" onClick={downloadPdf} className="ml-auto" disabled={!content.trim() && !summaryText.trim()}>
                    <Download className="h-4 w-4 mr-2" />
                    Download PDF
                  </Button>
                </div>

                {audioUrl && (
                  <div className="border-b border-border px-3 sm:px-4 py-3">
                    <div className="rounded-lg border border-border bg-background/60 p-3 space-y-2 max-w-full overflow-hidden">
                      <div className="text-xs text-muted-foreground">
                        {audioStatus || "Audio is ready."}
                      </div>
                      <audio
                        key={audioUrl}
                        controls
                        src={audioUrl}
                        autoPlay
                        className="w-full max-w-full"
                        onLoadedMetadata={(e) => {
                          e.currentTarget.playbackRate = playbackSpeed;
                        }}
                        onPlay={(e) => {
                          e.currentTarget.playbackRate = playbackSpeed;
                          setSpeaking(true);
                        }}
                        onPause={() => setSpeaking(false)}
                        onEnded={() => {
                          setSpeaking(false);
                          setAudioStatus("Playback finished.");
                        }}
                        onError={() => {
                          setSpeaking(false);
                          setAudioStatus("The browser could not play this audio file.");
                        }}
                      />
                    </div>
                  </div>
                )}

                {summaryText && showRagPanel && (
                  <div className="border-b border-border p-3 sm:p-4 bg-secondary/20 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm font-medium text-primary">{summaryTitle || "Summary"}</p>
                      <div className="flex items-center gap-2">
                        <Button size="sm" variant="secondary" onClick={insertSummaryIntoNote}>Insert into note</Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setSummaryText("");
                            setSummaryAnalogy("");
                            setSummaryBullets([]);
                            setSummaryKeyTerms([]);
                            setSummaryVisualFlow([]);
                          }}
                        >
                          Dismiss
                        </Button>
                      </div>
                    </div>
                    <Card className="p-3 text-sm whitespace-pre-wrap leading-relaxed">
                      {summaryText}
                    </Card>

                    {summaryMode === "eli5" && summaryAnalogy && (
                      <Card className="p-3 text-sm">
                        <p className="font-medium text-primary mb-1">Simple analogy</p>
                        <p className="text-muted-foreground">{summaryAnalogy}</p>
                      </Card>
                    )}

                    {summaryMode === "eli5" && summaryBullets.length > 0 && (
                      <Card className="p-3 text-sm">
                        <p className="font-medium text-primary mb-2">Key ideas</p>
                        <ul className="list-disc pl-5 space-y-1 text-muted-foreground">
                          {summaryBullets.map((point, i) => (
                            <li key={`${point}-${i}`}>{point}</li>
                          ))}
                        </ul>
                      </Card>
                    )}

                    {summaryMode === "eli5" && summaryVisualFlow.length > 0 && (
                      <Card className="p-3 text-sm">
                        <p className="font-medium text-primary mb-3">Visual concept flow</p>
                        <div className="overflow-x-auto">
                          <div className="flex items-stretch gap-2 min-w-max">
                            {summaryVisualFlow.map((step, i) => (
                              <div key={`${step.label}-${i}`} className="flex items-center gap-2">
                                <div className="w-56 rounded-lg border border-border bg-background/70 p-3">
                                  <p className="font-medium text-foreground">{step.label}</p>
                                  {step.note && <p className="text-xs text-muted-foreground mt-1">{step.note}</p>}
                                </div>
                                {i < summaryVisualFlow.length - 1 && <ArrowRight className="h-4 w-4 text-muted-foreground" />}
                              </div>
                            ))}
                          </div>
                        </div>
                      </Card>
                    )}

                    {summaryMode === "eli5" && summaryKeyTerms.length > 0 && (
                      <Card className="p-3 text-sm">
                        <p className="font-medium text-primary mb-2">Key terms</p>
                        <div className="flex flex-wrap gap-2">
                          {summaryKeyTerms.map((term, i) => (
                            <span key={`${term}-${i}`} className="px-2 py-1 rounded-md bg-secondary text-secondary-foreground text-xs">
                              {term}
                            </span>
                          ))}
                        </div>
                      </Card>
                    )}
                  </div>
                )}

                {summaryText && !showRagPanel ? (
                  <div className="flex-1 min-h-0">
                    <ResizablePanelGroup direction="vertical" className="h-full">
                      <ResizablePanel defaultSize={42} minSize={24} maxSize={70} className="min-h-0 overflow-hidden">
                        <div className="h-full border-b border-border p-3 sm:p-4 bg-secondary/20 space-y-3 overflow-y-auto overflow-x-hidden scrollbar-hide">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <p className="text-sm font-medium text-primary">{summaryTitle || "Summary"}</p>
                            <div className="flex items-center gap-2">
                              <Button size="sm" variant="secondary" onClick={insertSummaryIntoNote}>Insert into note</Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => {
                                  setSummaryText("");
                                  setSummaryAnalogy("");
                                  setSummaryBullets([]);
                                  setSummaryKeyTerms([]);
                                  setSummaryVisualFlow([]);
                                }}
                              >
                                Dismiss
                              </Button>
                            </div>
                          </div>
                          <Card className="p-3 text-sm whitespace-pre-wrap leading-relaxed">
                            {summaryText}
                          </Card>

                          {summaryMode === "eli5" && summaryAnalogy && (
                            <Card className="p-3 text-sm">
                              <p className="font-medium text-primary mb-1">Simple analogy</p>
                              <p className="text-muted-foreground">{summaryAnalogy}</p>
                            </Card>
                          )}

                          {summaryMode === "eli5" && summaryBullets.length > 0 && (
                            <Card className="p-3 text-sm">
                              <p className="font-medium text-primary mb-2">Key ideas</p>
                              <ul className="list-disc pl-5 space-y-1 text-muted-foreground">
                                {summaryBullets.map((point, i) => (
                                  <li key={`${point}-${i}`}>{point}</li>
                                ))}
                              </ul>
                            </Card>
                          )}

                          {summaryMode === "eli5" && summaryVisualFlow.length > 0 && (
                            <Card className="p-3 text-sm">
                              <p className="font-medium text-primary mb-3">Visual concept flow</p>
                              <div className="overflow-x-auto">
                                <div className="flex items-stretch gap-2 min-w-max">
                                  {summaryVisualFlow.map((step, i) => (
                                    <div key={`${step.label}-${i}`} className="flex items-center gap-2">
                                      <div className="w-56 rounded-lg border border-border bg-background/70 p-3">
                                        <p className="font-medium text-foreground">{step.label}</p>
                                        {step.note && <p className="text-xs text-muted-foreground mt-1">{step.note}</p>}
                                      </div>
                                      {i < summaryVisualFlow.length - 1 && <ArrowRight className="h-4 w-4 text-muted-foreground" />}
                                    </div>
                                  ))}
                                </div>
                              </div>
                            </Card>
                          )}

                          {summaryMode === "eli5" && summaryKeyTerms.length > 0 && (
                            <Card className="p-3 text-sm">
                              <p className="font-medium text-primary mb-2">Key terms</p>
                              <div className="flex flex-wrap gap-2">
                                {summaryKeyTerms.map((term, i) => (
                                  <span key={`${term}-${i}`} className="px-2 py-1 rounded-md bg-secondary text-secondary-foreground text-xs">
                                    {term}
                                  </span>
                                ))}
                              </div>
                            </Card>
                          )}
                        </div>
                      </ResizablePanel>

                      <ResizableHandle
                        className={cn(INVISIBLE_VERTICAL_RESIZE_HANDLE)}
                      />

                      <ResizablePanel minSize={30} className="min-h-0">
                        <Textarea
                          value={content}
                          onChange={(e) => setContent(e.target.value)}
                          placeholder="Start typing, paste study material, upload a PDF, or use the mic…"
                          className="h-full resize-none border-0 focus-visible:ring-0 rounded-none p-4 sm:p-6 text-sm sm:text-base leading-relaxed font-sans"
                        />
                      </ResizablePanel>
                    </ResizablePanelGroup>
                  </div>
                ) : showRagPanel ? (
                  <div className="flex-1 min-h-0">
                    <ResizablePanelGroup direction="vertical" className="h-full">
                      <ResizablePanel defaultSize={42} minSize={25} maxSize={70} className="min-h-0 overflow-hidden">
                        <div className="h-full border-b border-border p-3 sm:p-4 bg-secondary/30 space-y-3 overflow-y-auto overflow-x-hidden scrollbar-hide">
                          <div className="flex items-center gap-2">
                            <Input
                              value={ragQuestion}
                              onChange={(e) => setRagQuestion(e.target.value)}
                              placeholder="Ask anything about this document…"
                              onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && askRag()}
                              className="flex-1"
                            />
                            <Button size="sm" onClick={askRag} disabled={ragLoading || !ragQuestion.trim()}>
                              {ragLoading
                                ? <Loader2 className="h-4 w-4 animate-spin" />
                                : <Send className="h-4 w-4" />}
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => { setRagOpen(false); setRagAnswer(""); setRagSources([]); }}
                            >
                              <X className="h-4 w-4" />
                            </Button>
                          </div>

                          {ragAnswer && (
                            <Card className="p-3 text-sm space-y-2">
                              <p className="font-medium text-primary">Answer</p>
                              <p className="leading-relaxed whitespace-pre-wrap">{ragAnswer}</p>
                              {ragSources.length > 0 && (
                                <details className="text-xs text-muted-foreground">
                                  <summary className="cursor-pointer hover:text-foreground transition-colors">
                                    {ragSources.length} source chunk{ragSources.length > 1 ? "s" : ""}
                                  </summary>
                                  <div className="mt-2 space-y-2">
                                    {ragSources.map((s, i) => (
                                      <p key={i} className="border-l-2 border-border pl-2 line-clamp-3">{s}</p>
                                    ))}
                                  </div>
                                </details>
                              )}
                            </Card>
                          )}
                        </div>
                      </ResizablePanel>

                      <ResizableHandle
                        className={cn(INVISIBLE_VERTICAL_RESIZE_HANDLE)}
                      />

                      <ResizablePanel minSize={30} className="min-h-0">
                        <Textarea
                          value={content}
                          onChange={(e) => setContent(e.target.value)}
                          placeholder="Start typing, paste study material, upload a PDF, or use the mic…"
                          className="h-full resize-none border-0 focus-visible:ring-0 rounded-none p-4 sm:p-6 text-sm sm:text-base leading-relaxed font-sans"
                        />
                      </ResizablePanel>
                    </ResizablePanelGroup>
                  </div>
                ) : (
                  <Textarea
                    value={content}
                    onChange={(e) => setContent(e.target.value)}
                    placeholder="Start typing, paste study material, upload a PDF, or use the mic…"
                    className="flex-1 resize-none border-0 focus-visible:ring-0 rounded-none p-4 sm:p-6 text-sm sm:text-base leading-relaxed font-sans"
                  />
                )}
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center text-center p-10">
                <div>
                  <div className="h-16 w-16 mx-auto rounded-2xl bg-secondary flex items-center justify-center mb-4">
                    <FileText className="h-8 w-8 text-primary" />
                  </div>
                  <h2 className="font-display text-xl font-semibold">No note selected</h2>
                  <p className="text-muted-foreground mt-2">Create a note or upload a PDF to get started.</p>
                  <Button onClick={newNote} className="mt-4 bg-gradient-primary text-primary-foreground">
                    <Plus className="h-4 w-4 mr-2" /> New note
                  </Button>
                </div>
              </div>
            )}
          </ResizablePanel>
        </ResizablePanelGroup>
        ) : null
      )}
    </div>
  );
}
