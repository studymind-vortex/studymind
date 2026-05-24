import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { Brain, FileText, MessageSquare, Sparkles, Layers, LogOut, Menu, Moon, Sun, UserCircle2, LayoutDashboard, Github, ExternalLink } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useTheme } from "next-themes";
import { getStoredAiMode, getStoredApiKey, type AiMode } from "@/lib/ollama";
import { checkBackend } from "@/lib/rag";

const githubUrl = "https://github.com/c-varshith/studymind";

const nav = [
  { to: "/app", label: "Notes", icon: FileText, end: true },
  { to: "/app/chat", label: "AI Tutor", icon: MessageSquare },
  { to: "/app/quiz", label: "Quizzes", icon: Sparkles },
  { to: "/app/flashcards", label: "Flashcards", icon: Layers },
];

const mobileTabs = [
  { to: "/app", label: "Notes", icon: FileText, end: true },
  { to: "/app/chat", label: "Tutor", icon: MessageSquare },
  { to: "/app/quiz", label: "Quiz", icon: Sparkles },
  { to: "/app/flashcards", label: "Cards", icon: Layers },
  { to: "/app/dashboard", label: "Stats", icon: LayoutDashboard },
];

export default function AppShell() {
  const { signOut } = useAuth();
  const nav2 = useNavigate();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const { theme, setTheme } = useTheme();
  const [aiMode, setAiMode] = useState<AiMode>("local");
  const [connected, setConnected] = useState<boolean | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    let mounted = true;

    const updateStatus = async () => {
      try {
        const mode = getStoredAiMode();
        setAiMode(mode);

        if (mode === "local") {
          if (!mounted) return;
          setConnected(null);
          return;
        }

        const key = getStoredApiKey();
        if (!key) {
          if (!mounted) return;
          setConnected(false);
          return;
        }

        const ok = await checkBackend();
        if (!mounted) return;
        setConnected(ok);
      } catch {
        if (!mounted) return;
        setConnected(false);
      }
    };

    void updateStatus();

    const onConfig = () => void updateStatus();
    const onStorage = () => void updateStatus();

    window.addEventListener("studymind:ai-config-updated", onConfig);
    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", onConfig);

    return () => {
      mounted = false;
      window.removeEventListener("studymind:ai-config-updated", onConfig);
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", onConfig);
    };
  }, []);

  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  const handleSignOut = async () => {
    await signOut();
    nav2("/auth");
  };

  const toggleTheme = () => {
    if (!mounted) return;
    setTheme(theme === "dark" ? "light" : "dark");
  };

  const showDesktopTopDivider = location.pathname === "/app" || location.pathname === "/app/chat";
  const showDesktopTopLabel = location.pathname !== "/app/quiz" && location.pathname !== "/app/flashcards";

  return (
    <div className="h-screen overflow-hidden bg-background flex">
      {/* Sidebar */}
      <aside
        className={cn(
          "fixed md:static inset-y-0 left-0 z-40 w-[80vw] max-w-72 md:w-64 bg-sidebar border-r border-sidebar-border flex flex-col overflow-y-auto transition-transform",
          open ? "translate-x-0" : "-translate-x-full md:translate-x-0",
        )}
      >
        <NavLink
          to="/app"
          end
          onClick={() => setOpen(false)}
          className="p-5 flex items-center gap-2 border-b border-sidebar-border hover:bg-sidebar-accent/60 transition-colors"
          aria-label="Go to StudyMind home"
        >
          <div className="h-9 w-9 rounded-xl bg-gradient-primary flex items-center justify-center shadow-soft">
            <Brain className="h-5 w-5 text-primary-foreground" />
          </div>
          <span className="font-display font-bold text-lg text-sidebar-foreground">StudyMind</span>
        </NavLink>
        <nav className="flex-1 p-3 space-y-1">
          {nav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              onClick={() => setOpen(false)}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors",
                  isActive
                    ? "bg-gradient-primary text-primary-foreground shadow-soft"
                    : "text-sidebar-foreground hover:bg-sidebar-accent",
                )
              }
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="p-3 border-t border-sidebar-border">
          <NavLink
            to="/app/dashboard"
            onClick={() => setOpen(false)}
            className={({ isActive }) =>
              cn(
                "mb-1 flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors",
                isActive
                  ? "bg-gradient-primary text-primary-foreground shadow-soft"
                  : "text-sidebar-foreground hover:bg-sidebar-accent",
              )
            }
          >
            <LayoutDashboard className="h-4 w-4" />
            Dashboard
          </NavLink>
          <NavLink
            to="/app/profile"
            onClick={() => setOpen(false)}
            className={({ isActive }) =>
              cn(
                "mb-1 flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors",
                isActive
                  ? "bg-gradient-primary text-primary-foreground shadow-soft"
                  : "text-sidebar-foreground hover:bg-sidebar-accent",
              )
            }
          >
            <UserCircle2 className="h-4 w-4" />
            Profile
          </NavLink>
          <button
            type="button"
            onClick={handleSignOut}
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors text-sidebar-foreground hover:bg-sidebar-accent"
          >
            <LogOut className="h-4 w-4" />
            Sign out
          </button>
          <div className="mt-3 rounded-xl border border-sidebar-border/80 bg-sidebar-accent/40 p-3 shadow-sm">
            <p className="text-xs font-semibold uppercase tracking-wide text-sidebar-foreground/70">Local models</p>
            <p className="mt-1 text-sm text-sidebar-foreground/80">
              Follow the GitHub repo for Ollama setup, ngrok instructions, and AI endpoint configuration.
            </p>
            <a
              href={githubUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-sidebar-primary px-3 py-2 text-sm font-medium text-sidebar-primary-foreground transition-colors hover:opacity-90"
            >
              <Github className="h-4 w-4" />
              Open GitHub repo
              <ExternalLink className="h-4 w-4" />
            </a>
          </div>
        </div>
      </aside>

      {/* Mobile overlay */}
      {open && <div className="fixed inset-0 bg-black/40 z-30 md:hidden" onClick={() => setOpen(false)} />}

      {/* Main */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className={cn("hidden md:flex p-3 items-center relative", showDesktopTopDivider && "border-b border-border")}>
          <div className="absolute left-5 flex items-center gap-2">
            <span className="relative inline-flex items-center justify-center">
              {aiMode === "local" ? (
                <>
                  <span className="h-3 w-3 rounded-full bg-amber-500 shadow" />
                  <span className="absolute inline-flex h-3 w-3 rounded-full bg-amber-500 opacity-60 blur-sm animate-pulse" />
                </>
              ) : connected ? (
                <>
                  <span className="h-3 w-3 rounded-full bg-green-500 shadow" />
                  <span className="absolute inline-flex h-3 w-3 rounded-full bg-green-500 opacity-60 blur-sm animate-ping" />
                </>
              ) : (
                <>
                  <span className="h-3 w-3 rounded-full bg-red-500 shadow" />
                  <span className="absolute inline-flex h-3 w-3 rounded-full bg-red-500 opacity-60 blur-sm animate-pulse" />
                </>
              )}
            </span>
            <span className="text-sm font-medium text-muted-foreground">
              {aiMode === "local" ? "Local Model Mode" : connected ? "API Key Connected" : "API Key Disconnected"}
            </span>
          </div>
          {showDesktopTopLabel && (
            <p className="text-sm text-muted-foreground font-medium absolute left-1/2 -translate-x-1/2">AI Tutor Based Learning</p>
          )}
          <Button variant="ghost" size="icon" className="ml-auto" onClick={toggleTheme} disabled={!mounted} aria-label="Toggle theme">
            {mounted && theme === "dark" ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
          </Button>
        </header>
        <header className="md:hidden sticky top-0 z-20 border-b border-border bg-background/95 backdrop-blur p-3 flex items-center justify-center gap-2 relative">
          <Button variant="ghost" size="icon" onClick={() => setOpen(true)} aria-label="Open menu" className="absolute left-3"><Menu className="h-5 w-5" /></Button>
          <div className="flex items-center gap-2">
            <span className="relative inline-flex items-center justify-center">
              {aiMode === "local" ? (
                <>
                  <span className="h-3 w-3 rounded-full bg-amber-500 shadow" />
                  <span className="absolute inline-flex h-3 w-3 rounded-full bg-amber-500 opacity-60 blur-sm animate-pulse" />
                </>
              ) : connected ? (
                <>
                  <span className="h-3 w-3 rounded-full bg-green-500 shadow" />
                  <span className="absolute inline-flex h-3 w-3 rounded-full bg-green-500 opacity-60 blur-sm animate-ping" />
                </>
              ) : (
                <>
                  <span className="h-3 w-3 rounded-full bg-red-500 shadow" />
                  <span className="absolute inline-flex h-3 w-3 rounded-full bg-red-500 opacity-60 blur-sm animate-pulse" />
                </>
              )}
            </span>
            <span className="text-sm font-medium">{aiMode === "local" ? "Local Model Mode" : connected ? "API Key Connected" : "API Key Disconnected"}</span>
          </div>
          <Button variant="ghost" size="icon" className="absolute right-3" onClick={toggleTheme} disabled={!mounted} aria-label="Toggle theme">
            {mounted && theme === "dark" ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
          </Button>
        </header>
        <main className="flex-1 overflow-auto pb-[calc(5rem+env(safe-area-inset-bottom))] md:pb-0">
          <Outlet />
        </main>

        <nav className="md:hidden fixed bottom-0 left-0 right-0 z-20 border-t border-border bg-background/95 backdrop-blur px-2 pt-1 pb-[calc(0.4rem+env(safe-area-inset-bottom))]">
          <ul className="grid grid-cols-5 gap-1">
            {mobileTabs.map((item) => (
              <li key={item.to} className="min-w-0">
                <NavLink
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) =>
                    cn(
                      "flex min-w-0 flex-col items-center justify-center gap-1 rounded-lg py-1.5 text-[10px] font-medium transition-colors",
                      isActive
                        ? "bg-secondary text-foreground"
                        : "text-muted-foreground",
                    )
                  }
                >
                  <item.icon className="h-4 w-4 shrink-0" />
                  <span className="max-w-full truncate leading-none">{item.label}</span>
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </div>
    );
  }
