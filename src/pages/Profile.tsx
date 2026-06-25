import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/hooks/use-toast";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Loader2, Save, Shield, UserCircle2, Trash2, ExternalLink } from "lucide-react";
import { checkBackend } from "@/lib/rag";
import { deleteCurrentAccount } from "@/lib/api";
import {
  getStoredAiMode,
  getStoredApiKey,
  getStoredOllamaUrl,
  setStoredAiMode,
  setStoredApiKey,
  setStoredOllamaUrl,
  type AiMode,
} from "@/lib/ollama";

interface ProfileRow {
  id: string;
  user_id: string;
  display_name: string | null;
  created_at: string;
  updated_at: string;
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export default function Profile() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const [profileLoading, setProfileLoading] = useState(true);
  const [savingProfile, setSavingProfile] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);
  const [savingOllama, setSavingOllama] = useState(false);
  const [testingConnection, setTestingConnection] = useState(false);
  const [deletingAccount, setDeletingAccount] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  const [displayName, setDisplayName] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [aiMode, setAiMode] = useState<AiMode>("local");
  const [ollamaUrl, setOllamaUrl] = useState("");
  const [apiKey, setApiKey] = useState("");

  const createdAtText = useMemo(() => {
    if (!user?.created_at) return "-";
    return new Date(user.created_at).toLocaleString();
  }, [user?.created_at]);

  useEffect(() => {
    setAiMode(getStoredAiMode());
    setOllamaUrl(getStoredOllamaUrl());
    setApiKey(getStoredApiKey());

    const loadProfile = async () => {
      if (!user) {
        setProfileLoading(false);
        return;
      }

      const { data, error } = await supabase
        .from("profiles")
        .select("*")
        .eq("user_id", user.id)
        .maybeSingle();

      if (error) {
        toast({ title: "Could not load profile", description: error.message, variant: "destructive" });
      }

      const row = data as ProfileRow | null;
      setDisplayName(row?.display_name ?? (user.user_metadata?.display_name ?? ""));
      setProfileLoading(false);
    };

    void loadProfile();
  }, [user]);

  const saveProfile = async () => {
    if (!user) return;
    setSavingProfile(true);
    try {
      const name = displayName.trim() || null;

      const { error: upsertError } = await supabase
        .from("profiles")
        .upsert(
          {
            user_id: user.id,
            display_name: name,
          },
          { onConflict: "user_id" },
        );

      if (upsertError) throw upsertError;

      const { error: authError } = await supabase.auth.updateUser({
        data: { display_name: name ?? "" },
      });

      if (authError) throw authError;

      toast({ title: "Profile saved", description: "Your display name has been updated." });
    } catch (e: unknown) {
      toast({ title: "Save failed", description: errorMessage(e, "Profile save failed."), variant: "destructive" });
    } finally {
      setSavingProfile(false);
    }
  };

  const changePassword = async () => {
    if (!newPassword || !confirmPassword) {
      toast({ title: "Missing fields", description: "Please fill both password fields.", variant: "destructive" });
      return;
    }
    if (newPassword.length < 6) {
      toast({ title: "Weak password", description: "Use at least 6 characters.", variant: "destructive" });
      return;
    }
    if (newPassword !== confirmPassword) {
      toast({ title: "Passwords do not match", description: "Please re-check and try again.", variant: "destructive" });
      return;
    }

    setChangingPassword(true);
    try {
      const { error } = await supabase.auth.updateUser({ password: newPassword });
      if (error) throw error;

      setNewPassword("");
      setConfirmPassword("");
      toast({ title: "Password updated", description: "Your password has been changed successfully." });
    } catch (e: unknown) {
      toast({ title: "Password update failed", description: errorMessage(e, "Password update failed."), variant: "destructive" });
    } finally {
      setChangingPassword(false);
    }
  };

  const saveOllamaUrl = async () => {
    setSavingOllama(true);
    try {
      const modeToSave: AiMode = aiMode;
      const savedMode = setStoredAiMode(modeToSave);
      const savedEndpoint = setStoredOllamaUrl(ollamaUrl);
      const savedApiKey = modeToSave === "api-key" ? setStoredApiKey(apiKey) : setStoredApiKey("");

      setAiMode(savedMode);
      setOllamaUrl(savedEndpoint);
      setApiKey(savedApiKey);

      toast({
        title: "AI endpoint saved",
        description:
          savedMode === "local"
            ? savedEndpoint
              ? "Local model mode enabled with your configured endpoint."
              : "Local model mode enabled. App will use backend default local endpoint."
            : "API key mode enabled. AI calls will include your endpoint and key.",
      });
    } catch (e: unknown) {
      toast({ title: "Invalid URL", description: errorMessage(e, "Invalid endpoint URL."), variant: "destructive" });
    } finally {
      setSavingOllama(false);
    }
  };

  const testAiConnection = async () => {
    setTestingConnection(true);
    try {
      const modeToTest: AiMode = aiMode;
      const savedMode = setStoredAiMode(modeToTest);
      const savedEndpoint = setStoredOllamaUrl(ollamaUrl);
      const savedApiKey = modeToTest === "api-key" ? setStoredApiKey(apiKey) : setStoredApiKey("");

      setAiMode(savedMode);
      setOllamaUrl(savedEndpoint);
      setApiKey(savedApiKey);

      const result = await checkBackend();
      if (result.ok) {
        toast({
          title: "Connection successful",
          description:
            savedMode === "local"
              ? "Local model endpoint is reachable."
              : "Endpoint is reachable with current API key mode settings.",
        });
        return;
      }

      toast({
        title: "Connection failed",
        description: result.detail || "Could not reach the AI backend. Verify endpoint URL, key, and backend status.",
        variant: "destructive",
      });
    } catch (e: unknown) {
      toast({
        title: "Connection failed",
        description: errorMessage(e, "Could not validate AI connection."),
        variant: "destructive",
      });
    } finally {
      setTestingConnection(false);
    }
  };

  const deleteAccount = async () => {
    if (!user) return;
    setDeletingAccount(true);
    try {
      await deleteCurrentAccount();
      await supabase.auth.signOut({ scope: "local" });

      setStoredApiKey("");
      setStoredOllamaUrl("");
      setStoredAiMode("local");

      toast({
        title: "Account deleted",
        description: "Your account and all associated data have been permanently deleted.",
      });

      navigate("/", { replace: true });
    } catch (e: unknown) {
      toast({
        title: "Deletion failed",
        description: errorMessage(e, "Could not delete your account. Your data is still safe. Please try again or contact support."),
        variant: "destructive",
      });
    } finally {
      setDeletingAccount(false);
      setShowDeleteDialog(false);
    }
  };

  if (!user) {
    return (
      <div className="p-4 sm:p-6 max-w-4xl mx-auto">
        <Card className="p-6 text-sm text-muted-foreground">You are not signed in.</Card>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 max-w-4xl mx-auto space-y-6">
      <header>
        <h1 className="font-display text-2xl font-bold">Profile & Account</h1>
        <p className="text-muted-foreground text-sm">Manage your account details and security settings.</p>
      </header>

      <Card className="p-4 sm:p-6 space-y-4">
        <div className="flex items-center gap-2">
          <UserCircle2 className="h-5 w-5 text-primary" />
          <h2 className="font-display text-lg font-semibold">Profile</h2>
        </div>

        <div className="grid md:grid-cols-2 gap-4 text-sm">
          <div>
            <Label>Email</Label>
            <Input value={user.email ?? ""} disabled />
          </div>
          <div>
            <Label>Member Since</Label>
            <Input value={createdAtText} disabled />
          </div>
          <div className="md:col-span-2">
            <Label htmlFor="displayName">Display Name</Label>
            <Input
              id="displayName"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Your name"
              disabled={profileLoading || savingProfile}
            />
          </div>
        </div>

        <Button onClick={saveProfile} disabled={profileLoading || savingProfile} className="bg-gradient-primary text-primary-foreground">
          {savingProfile ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
          Save profile
        </Button>
      </Card>

      <Card className="p-4 sm:p-6 space-y-4">
        <div className="flex items-center gap-2">
          <Shield className="h-5 w-5 text-primary" />
          <h2 className="font-display text-lg font-semibold">Security</h2>
        </div>

        <div className="grid md:grid-cols-2 gap-4">
          <div>
            <Label htmlFor="newPassword">New Password</Label>
            <Input
              id="newPassword"
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="At least 6 characters"
              disabled={changingPassword}
            />
          </div>
          <div>
            <Label htmlFor="confirmPassword">Confirm New Password</Label>
            <Input
              id="confirmPassword"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Repeat password"
              disabled={changingPassword}
            />
          </div>
        </div>

        <Button onClick={changePassword} disabled={changingPassword} variant="secondary">
          {changingPassword ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Shield className="h-4 w-4 mr-2" />}
          Change password
        </Button>
      </Card>

      <Card className="p-4 sm:p-6 space-y-4">
        <div className="flex items-center gap-2">
          <h2 className="font-display text-lg font-semibold">AI Endpoint</h2>
        </div>

        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 rounded-md border p-3">
          <div>
            <p className="text-sm font-medium">Use local model</p>
            <p className="text-xs text-muted-foreground">Disabled by default. Enable to use endpoint + local model mode.</p>
          </div>
          <Switch
            checked={aiMode === "local"}
            onCheckedChange={(checked) => setAiMode(checked ? "local" : "api-key")}
            disabled={savingOllama}
            aria-label="Toggle local model mode"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="ollamaUrl">AI endpoint URL (optional)</Label>
          <Input
            id="ollamaUrl"
            value={ollamaUrl}
            onChange={(e) => setOllamaUrl(e.target.value)}
            placeholder="https://your-tunnel.ngrok-free.dev"
            disabled={savingOllama}
          />
          <p className="text-xs text-muted-foreground">
            In local mode, this can point to your Ollama tunnel URL (for example ngrok/Cloudflare tunnel to port 11434).
            In API key mode, this is the endpoint that will receive authenticated model requests.
          </p>
        </div>

        {aiMode === "api-key" && (
          <div className="space-y-2">
            <Label htmlFor="apiKey">API key</Label>
            <Input
              id="apiKey"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-..."
              disabled={savingOllama}
            />
            <p className="text-xs text-muted-foreground">
              Your key is stored in browser local storage and sent in request headers only when local mode is disabled.
            </p>
            <div className="flex items-center gap-2 text-xs">
              <span className="text-muted-foreground">Don't have one?</span>
              <a
                href="https://openrouter.ai/workspaces/default/keys"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 px-2 py-1 rounded-md text-sm font-medium text-primary hover:bg-primary/5"
              >
                <ExternalLink className="h-4 w-4" />
                Get a key
              </a>
            </div>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <Button onClick={saveOllamaUrl} disabled={savingOllama || testingConnection} variant="secondary">
            {savingOllama ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
            Save AI settings
          </Button>
          <Button onClick={testAiConnection} disabled={testingConnection || savingOllama} variant="outline">
            {testingConnection ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
            Test connection
          </Button>
        </div>
      </Card>

      {/* Delete Account section */}
      <Card className="p-4 sm:p-6 space-y-4 border-destructive/30 bg-destructive/5">
        <div className="flex items-center gap-2">
          <Trash2 className="h-5 w-5 text-destructive" />
          <h2 className="font-display text-lg font-semibold text-destructive">Danger Zone</h2>
        </div>

        <p className="text-sm text-muted-foreground">
          Permanently delete your account and all associated data. This action cannot be undone.
        </p>

        <Button 
          onClick={() => setShowDeleteDialog(true)} 
          disabled={deletingAccount}
          variant="destructive"
          className="w-full sm:w-auto"
        >
          {deletingAccount ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Trash2 className="h-4 w-4 mr-2" />}
          Delete my account
        </Button>
      </Card>

      {/* Delete confirmation dialog */}
      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Account?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete your account and all your data including:
              <ul className="mt-3 space-y-1 text-sm text-foreground font-medium">
                <li>• All notes and tags</li>
                <li>• All quizzes and results</li>
                <li>• All flashcard decks</li>
                <li>• All uploaded documents</li>
                <li>• All chat conversations</li>
              </ul>
              <p className="mt-3">This action cannot be undone. Are you absolutely sure?</p>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex gap-2">
            <AlertDialogCancel disabled={deletingAccount}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={deleteAccount}
              disabled={deletingAccount}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deletingAccount ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
              Delete Account
            </AlertDialogAction>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
