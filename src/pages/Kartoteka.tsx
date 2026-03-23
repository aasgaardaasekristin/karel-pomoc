import { useState, useEffect, useCallback, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import ThemeQuickButton from "@/components/ThemeQuickButton";
import { useTheme } from "@/contexts/ThemeContext";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useActiveSessions } from "@/contexts/ActiveSessionsContext";
import { useChatContext } from "@/contexts/ChatContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import {
  ArrowLeft,
  Plus,
  User,
  FileText,
  ListChecks,
  Loader2,
  Trash2,
  Edit3,
  Save,
  X,
  ChevronRight,
  MessageSquare,
  LogOut,
  HardDriveDownload,
  Search,
  Image as ImageIcon,
  Paperclip,
  Eye,
} from "lucide-react";
import { toast } from "sonner";
import ReactMarkdown from "react-markdown";
import { exportSessionReportPdf } from "@/lib/sessionPdfExport";
import ClientDiscussionChat from "@/components/report/ClientDiscussionChat";
import ClientSessionPrepPanel from "@/components/report/ClientSessionPrepPanel";
import SessionIntakePanel from "@/components/report/SessionIntakePanel";
import ClientTasksPanel from "@/components/report/ClientTasksPanel";
import CardAnalysisPanel from "@/components/report/CardAnalysisPanel";
import LiveSessionPanel from "@/components/report/LiveSessionPanel";

type Client = {
  id: string;
  name: string;
  age: number | null;
  gender: string | null;
  diagnosis: string;
  therapy_type: string;
  referral_source: string;
  key_history: string;
  family_context: string;
  notes: string;
  therapy_plan: string;
  created_at: string;
  updated_at: string;
};

type ClientSession = {
  id: string;
  session_number: number | null;
  session_date: string;
  report_context: string;
  report_key_theme: string;
  report_therapist_emotions: string[];
  report_transference: string;
  report_risks: string[];
  report_missing_data: string;
  report_interventions_tried: string;
  report_next_session_goal: string;
  ai_analysis: string;
  ai_hypotheses: string;
  ai_recommended_methods: string;
  ai_risk_assessment: string;
  voice_analysis: string;
  notes: string;
  created_at: string;
};

type ClientTask = {
  id: string;
  task: string;
  method: string;
  status: string;
  due_date: string | null;
  result: string;
  notes: string;
  task_type?: string;
  priority?: string;
  answer?: string;
  created_at: string;
};

const Kartoteka = () => {
  const navigate = useNavigate();
  const { createSession, updateSessionPlan, setActiveSession, sessions: activeSessions } = useActiveSessions();
  const { setMainMode } = useChatContext();
  const { applyTemporaryTheme, restoreGlobalTheme, setLocalMode } = useTheme();
  const [clients, setClients] = useState<Client[]>([]);
  const [selectedClient, setSelectedClient] = useState<Client | null>(null);
  const [sessions, setSessions] = useState<ClientSession[]>([]);
  const [tasks, setTasks] = useState<ClientTask[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isEditing, setIsEditing] = useState(false);
  const [editData, setEditData] = useState<Partial<Client>>({});
  const [newClientName, setNewClientName] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [newTaskText, setNewTaskText] = useState("");
  const [expandedSession, setExpandedSession] = useState<string | null>(null);
  const [isBackingUp, setIsBackingUp] = useState(false);
  const [activePlan, setActivePlan] = useState<any>(null);
  const [cardAnalysis, setCardAnalysis] = useState<any>(null);
  const [activeTab, setActiveTab] = useState("card");
  const [clientAnalyses, setClientAnalyses] = useState<any[]>([]);
  const [sessionMaterials, setSessionMaterials] = useState<any[]>([]);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  // Compute localStorage storageKey based on selected client
  const kartotekaStorageKey = selectedClient ? `theme_kartoteka_${selectedClient.id}` : "theme_kartoteka";

  // Load theme from localStorage on mount/change, restore on unmount
  useEffect(() => {
    setLocalMode(kartotekaStorageKey);
    const saved = localStorage.getItem(kartotekaStorageKey);
    if (saved) {
      try { applyTemporaryTheme(JSON.parse(saved)); } catch {}
    }
    return () => { setLocalMode(null); restoreGlobalTheme(); };
  }, [kartotekaStorageKey]);

  const handleTabChange = (value: string) => {
    setActiveTab(value);
    if (value === "assistance" && selectedClient) {
      const existingSession = activeSessions?.find(s => s.clientId === selectedClient.id);
      if (existingSession) {
        setActiveSession(existingSession.id);
      } else {
        const sessionId = createSession(selectedClient.id, selectedClient.name);
        if (activePlan) updateSessionPlan(sessionId, activePlan);
      }
    }
  };

  const handleBackup = async () => {
    setIsBackingUp(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) { toast.error("Nejsi přihlášen/a"); return; }

      const res = await supabase.functions.invoke("karel-gdrive-backup", {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });

      if (res.error || !res.data?.success) {
        toast.error(res.data?.error || "Záloha selhala");
      } else {
        toast.success(res.data.message);
      }
    } catch (e: any) {
      toast.error(e.message || "Chyba při zálohování");
    } finally {
      setIsBackingUp(false);
    }
  };

  // Auth check
  useEffect(() => {
    const check = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) navigate("/", { replace: true });
    };
    check();
  }, [navigate]);

  // Fetch clients
  const fetchClients = useCallback(async () => {
    setIsLoading(true);
    const { data, error } = await supabase
      .from("clients")
      .select("*")
      .order("name");
    if (!error && data) setClients(data as Client[]);
    setIsLoading(false);
  }, []);

  useEffect(() => { fetchClients(); }, [fetchClients]);

  // Sync active session when switching clients while assistance tab is open
  useEffect(() => {
    if (activeTab !== "assistance" || !selectedClient) return;
    const existingSession = activeSessions?.find(s => s.clientId === selectedClient.id);
    if (existingSession) {
      setActiveSession(existingSession.id);
    } else {
      const sessionId = createSession(selectedClient.id, selectedClient.name);
      if (activePlan) updateSessionPlan(sessionId, activePlan);
    }
  }, [selectedClient?.id, activeTab]);

  // Fetch client detail
  const loadClientDetail = useCallback(async (client: Client) => {
    setSelectedClient(client);
    setIsEditing(false);

    const [sessionsRes, tasksRes, analysesRes, materialsRes] = await Promise.all([
      supabase
        .from("client_sessions")
        .select("*")
        .eq("client_id", client.id)
        .order("session_date", { ascending: false }),
      supabase
        .from("client_tasks")
        .select("*")
        .eq("client_id", client.id)
        .order("created_at", { ascending: false }),
      supabase
        .from("client_analyses")
        .select("*")
        .eq("client_id", client.id)
        .order("created_at", { ascending: false }),
      supabase
        .from("session_materials")
        .select("*")
        .eq("client_id", client.id)
        .order("created_at", { ascending: false }),
    ]);

    if (sessionsRes.data) setSessions(sessionsRes.data as ClientSession[]);
    if (tasksRes.data) setTasks(tasksRes.data as ClientTask[]);
    if (analysesRes.data) setClientAnalyses(analysesRes.data as any[]);
    if (materialsRes.data) setSessionMaterials(materialsRes.data as any[]);
  }, []);

  // Create client
  const handleCreateClient = async () => {
    if (!newClientName.trim()) return;
    setIsCreating(true);
    const { data, error } = await supabase
      .from("clients")
      .insert({ name: newClientName.trim() })
      .select()
      .single();
    if (error) {
      toast.error("Nepodařilo se vytvořit klienta");
    } else if (data) {
      toast.success(`Klient „${data.name}" vytvořen`);
      setNewClientName("");
      await fetchClients();
      loadClientDetail(data as Client);
    }
    setIsCreating(false);
  };

  // Save client edits
  const handleSaveClient = async () => {
    if (!selectedClient) return;
    const { error } = await supabase
      .from("clients")
      .update(editData)
      .eq("id", selectedClient.id);
    if (error) {
      toast.error("Nepodařilo se uložit");
    } else {
      toast.success("Karta klienta uložena");
      const updated = { ...selectedClient, ...editData } as Client;
      setSelectedClient(updated);
      setIsEditing(false);
      fetchClients();
    }
  };

  const [isSavingCard, setIsSavingCard] = useState(false);

  const handleSaveAndBackup = async () => {
    if (!selectedClient) return;
    setIsSavingCard(true);
    try {
      // 1. Save to DB
      const clientData = isEditing ? { ...selectedClient, ...editData } : selectedClient;
      if (isEditing) {
        const { error } = await supabase
          .from("clients")
          .update(editData)
          .eq("id", selectedClient.id);
        if (error) {
          toast.error("Nepodařilo se uložit do databáze");
          setIsSavingCard(false);
          return;
        }
        setSelectedClient(clientData as Client);
        setIsEditing(false);
        fetchClients();
      }

      // 2. Generate PDF
      const { default: jsPDF } = await import("jspdf");
      const doc = new jsPDF({ unit: "mm", format: "a4" });
      const margin = 15;
      let y = 20;
      const pageW = doc.internal.pageSize.getWidth() - 2 * margin;

      doc.setFontSize(16);
      doc.text(`Karta klienta: ${clientData.name}`, margin, y);
      y += 10;

      doc.setFontSize(10);
      doc.text(`Datum exportu: ${new Date().toLocaleDateString("cs-CZ")}`, margin, y);
      y += 8;

      const fields: [string, string | null | undefined][] = [
        ["Věk", clientData.age ? `${clientData.age} let` : null],
        ["Pohlaví", clientData.gender],
        ["Diagnóza", clientData.diagnosis],
        ["Typ terapie", clientData.therapy_type],
        ["Zdroj doporučení", clientData.referral_source],
        ["Klíčová anamnéza", clientData.key_history],
        ["Rodinný kontext", clientData.family_context],
        ["Poznámky", clientData.notes],
      ];

      doc.setFontSize(11);
      for (const [label, value] of fields) {
        if (!value) continue;
        if (y > 270) { doc.addPage(); y = 20; }
        doc.setFont("helvetica", "bold");
        doc.text(`${label}:`, margin, y);
        y += 5;
        doc.setFont("helvetica", "normal");
        const lines = doc.splitTextToSize(value, pageW);
        for (const line of lines) {
          if (y > 280) { doc.addPage(); y = 20; }
          doc.text(line, margin, y);
          y += 5;
        }
        y += 3;
      }

      // Add therapy plan if exists
      if (clientData.therapy_plan) {
        if (y > 250) { doc.addPage(); y = 20; }
        doc.setFont("helvetica", "bold");
        doc.setFontSize(13);
        doc.text("Terapeutický plán procesu", margin, y);
        y += 7;
        doc.setFont("helvetica", "normal");
        doc.setFontSize(10);
        const planLines = doc.splitTextToSize(clientData.therapy_plan, pageW);
        for (const line of planLines) {
          if (y > 280) { doc.addPage(); y = 20; }
          doc.text(line, margin, y);
          y += 4.5;
        }
      }

      const pdfBlob = doc.output("blob");
      const { blobToBase64 } = await import("@/lib/driveUtils");
      const pdfBase64 = await blobToBase64(pdfBlob);

      // 3. Backup to Drive
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        toast.warning("Uloženo do DB, ale nelze zálohovat – nejsi přihlášen/a");
        setIsSavingCard(false);
        return;
      }

      const dateStr = new Date().toISOString().slice(0, 10);
      const fileName = `Karta_${clientData.name.replace(/\s+/g, "_")}_${dateStr}.pdf`;

      supabase.functions.invoke("karel-session-drive-backup", {
        body: {
          pdfBase64,
          fileName,
          clientId: clientData.id,
          folder: "Karta",
        },
        headers: { Authorization: `Bearer ${session.access_token}` },
      }).then(res => {
        if (res.error || !res.data?.success) {
          console.warn("Drive backup failed:", res.data?.error || res.error);
        }
      });

      toast.success("Karta uložena a zálohována na Drive");
    } catch (e: any) {
      console.error("Save & backup error:", e);
      toast.error(e.message || "Chyba při ukládání");
    } finally {
      setIsSavingCard(false);
    }
  };

  // Delete client
  const handleDeleteClient = async (id: string) => {
    if (!confirm("Opravdu smazat tohoto klienta a všechny jeho záznamy?")) return;
    const { error } = await supabase.from("clients").delete().eq("id", id);
    if (error) {
      toast.error("Nepodařilo se smazat");
    } else {
      toast.success("Klient smazán");
      setSelectedClient(null);
      fetchClients();
    }
  };

  // Add task
  const handleAddTask = async () => {
    if (!selectedClient || !newTaskText.trim()) return;
    const { error } = await supabase
      .from("client_tasks")
      .insert({ client_id: selectedClient.id, task: newTaskText.trim() });
    if (error) {
      toast.error("Nepodařilo se přidat úkol");
    } else {
      setNewTaskText("");
      loadClientDetail(selectedClient);
    }
  };

  // Toggle task status
  const handleToggleTask = async (task: ClientTask) => {
    const nextStatus = task.status === "done" ? "planned" : "done";
    await supabase.from("client_tasks").update({ status: nextStatus }).eq("id", task.id);
    if (selectedClient) loadClientDetail(selectedClient);
  };

  // Delete task
  const handleDeleteTask = async (taskId: string) => {
    await supabase.from("client_tasks").delete().eq("id", taskId);
    if (selectedClient) loadClientDetail(selectedClient);
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
    navigate("/");
  };

  // ─── CLIENT LIST VIEW ───
  if (!selectedClient) {
    return (
      <div className="min-h-screen flex flex-col bg-background">
        <header className="border-b border-border bg-card/50 backdrop-blur-sm sticky top-0 z-10">
          <div className="max-w-4xl mx-auto px-3 sm:px-4 py-2.5 sm:py-4 flex items-center justify-between">
            <div className="min-w-0">
              <h1 className="text-base sm:text-xl font-serif font-semibold text-foreground">Kartotéka klientů</h1>
              <p className="text-xs sm:text-sm text-muted-foreground hidden sm:block">Přehled všech klientů a jejich dokumentace</p>
            </div>
            <div className="flex items-center gap-1 sm:gap-2">
              <Button variant="outline" size="sm" onClick={handleBackup} disabled={isBackingUp} className="h-8 px-2 sm:px-3">
                {isBackingUp ? <Loader2 className="w-4 h-4 animate-spin sm:mr-2" /> : <HardDriveDownload className="w-4 h-4 sm:mr-2" />}
                <span className="hidden sm:inline">{isBackingUp ? "Zálohuji..." : "Záloha"}</span>
              </Button>
              <Button variant="outline" size="sm" onClick={() => navigate("/chat")} className="h-8 px-2 sm:px-3">
                <MessageSquare className="w-4 h-4 sm:mr-2" />
                <span className="hidden sm:inline">Chat</span>
              </Button>
              <Button variant="ghost" size="sm" onClick={handleLogout} className="h-8 px-2 sm:px-3">
                <LogOut className="w-4 h-4 sm:mr-2" />
                <span className="hidden sm:inline">Odejít</span>
              </Button>
            </div>
          </div>
        </header>

        <div className="max-w-4xl mx-auto w-full px-3 sm:px-4 py-6 space-y-4 flex-1">
          {/* New client */}
          <div className="flex gap-2">
            <Input
              placeholder="Jméno nového klienta..."
              value={newClientName}
              onChange={(e) => setNewClientName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleCreateClient(); }}
              className="flex-1"
            />
            <Button onClick={handleCreateClient} disabled={!newClientName.trim() || isCreating}>
              {isCreating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4 mr-1" />}
              Nový klient
            </Button>
          </div>

          {/* Client list */}
          {isLoading ? (
            <div className="flex justify-center py-12">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          ) : clients.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <User className="w-12 h-12 mx-auto mb-3 opacity-30" />
              <p>Zatím nemáš žádné klienty.</p>
              <p className="text-sm">Založ prvního klienta výše.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {clients.map((client) => (
                <button
                  key={client.id}
                  onClick={() => loadClientDetail(client)}
                  className="w-full flex items-center gap-3 p-4 bg-card rounded-xl border border-border hover:border-primary/30 hover:bg-card/80 transition-all text-left group"
                >
                  <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                    <User className="w-5 h-5 text-primary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-foreground truncate">{client.name}</p>
                    <div className="flex gap-2 text-xs text-muted-foreground">
                      {client.diagnosis && <span>{client.diagnosis}</span>}
                      {client.therapy_type && <span>· {client.therapy_type}</span>}
                    </div>
                  </div>
                  <ChevronRight className="w-4 h-4 text-muted-foreground group-hover:text-primary transition-colors" />
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  // ─── CLIENT DETAIL VIEW ───
  return (
    <div className="min-h-screen flex flex-col bg-background">
      <header className="border-b border-border bg-card/50 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-3 sm:px-4 py-2.5 sm:py-4 flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <Button variant="ghost" size="icon" data-swipe-back="true" onClick={() => setSelectedClient(null)} className="shrink-0 h-8 w-8">
              <ArrowLeft className="w-4 h-4" />
            </Button>
            <div className="min-w-0">
              <h1 className="text-base sm:text-xl font-serif font-semibold text-foreground truncate">{selectedClient.name}</h1>
              {selectedClient.diagnosis && (
                <p className="text-xs text-muted-foreground truncate">{selectedClient.diagnosis}</p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              onClick={handleSaveAndBackup}
              disabled={isSavingCard}
              className="h-8 px-2 sm:px-3"
              title="Uložit kartu a zálohovat na Drive"
            >
              {isSavingCard ? <Loader2 className="w-3.5 h-3.5 animate-spin sm:mr-1" /> : <Save className="w-3.5 h-3.5 sm:mr-1" />}
              <span className="hidden sm:inline">{isSavingCard ? "Ukládám..." : "Uložit"}</span>
            </Button>
            {!isEditing ? (
              <Button variant="outline" size="sm" onClick={() => { setIsEditing(true); setEditData(selectedClient); }} className="h-8">
                <Edit3 className="w-3.5 h-3.5 sm:mr-1" />
                <span className="hidden sm:inline">Upravit</span>
              </Button>
            ) : (
              <Button variant="ghost" size="sm" onClick={() => setIsEditing(false)} className="h-8">
                <X className="w-3.5 h-3.5" />
              </Button>
            )}
            <Button variant="destructive" size="sm" onClick={() => handleDeleteClient(selectedClient.id)} className="h-8">
              <Trash2 className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>
      </header>

      <ScrollArea className="flex-1">
        <div className="max-w-4xl mx-auto px-3 sm:px-4 py-4">
          <Tabs value={activeTab} onValueChange={handleTabChange} className="space-y-4">
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <ThemeQuickButton storageKey={kartotekaStorageKey} />
                <TabsList className="inline-flex w-auto flex-1 h-auto flex-nowrap sm:grid sm:grid-cols-4">
                  <TabsTrigger value="card" className="gap-1 text-[11px] sm:text-sm px-2 sm:px-3 whitespace-nowrap">
                    <User className="w-3.5 h-3.5 hidden sm:block" />
                    Karta
                  </TabsTrigger>
                  <TabsTrigger value="intake" className="gap-1 text-[11px] sm:text-sm px-2 sm:px-3 whitespace-nowrap">
                    Záznam
                  </TabsTrigger>
                  <TabsTrigger value="sessions" className="gap-1 text-[11px] sm:text-sm px-2 sm:px-3 whitespace-nowrap">
                    <FileText className="w-3.5 h-3.5 hidden sm:block" />
                    Sezení
                    {sessions.length > 0 && <Badge variant="secondary" className="ml-0.5 text-[10px] hidden sm:inline">{sessions.length}</Badge>}
                  </TabsTrigger>
                  <TabsTrigger value="tasks" className="gap-1 text-[11px] sm:text-sm px-2 sm:px-3 whitespace-nowrap">
                    <ListChecks className="w-3.5 h-3.5 hidden sm:block" />
                    Úkoly
                    {tasks.filter(t => t.status !== "done").length > 0 && (
                      <Badge variant="secondary" className="ml-0.5 text-[10px] hidden sm:inline">{tasks.filter(t => t.status !== "done").length}</Badge>
                    )}
                  </TabsTrigger>
                </TabsList>
              </div>
              <div className="overflow-x-auto -mx-3 px-3 scrollbar-hide">
                <div className="flex items-center gap-1.5 min-w-max">
                  <span className="text-[10px] text-muted-foreground/70 shrink-0">Pracovní:</span>
                  <TabsList className="inline-flex w-auto h-auto flex-nowrap bg-muted/50">
                    <TabsTrigger value="analysis" className="gap-1 text-[10px] sm:text-xs px-2 sm:px-3 whitespace-nowrap text-muted-foreground data-[state=active]:text-foreground">
                      Analýza
                    </TabsTrigger>
                    <TabsTrigger value="prep" className="gap-1 text-[10px] sm:text-xs px-2 sm:px-3 whitespace-nowrap text-muted-foreground data-[state=active]:text-foreground">
                      Připravit sezení
                    </TabsTrigger>
                    <TabsTrigger value="assistance" className="gap-1 text-[10px] sm:text-xs px-2 sm:px-3 whitespace-nowrap text-muted-foreground data-[state=active]:text-foreground">
                      Asistence
                    </TabsTrigger>
                    <TabsTrigger value="discussion" className="gap-1 text-[10px] sm:text-xs px-2 sm:px-3 whitespace-nowrap text-muted-foreground data-[state=active]:text-foreground">
                      <MessageSquare className="w-3.5 h-3.5 hidden sm:block" />
                      Rozhovor
                    </TabsTrigger>
                  </TabsList>
                </div>
              </div>
            </div>

            {/* ─── KARTA ─── */}
            <TabsContent value="card" forceMount className={activeTab === "card" ? "space-y-4" : "hidden"}>
              <div className="bg-card rounded-xl border border-border p-4 sm:p-6 space-y-4">
                {isEditing ? (
                  <>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div className="space-y-1">
                        <Label>Jméno</Label>
                        <Input value={editData.name || ""} onChange={(e) => setEditData(p => ({ ...p, name: e.target.value }))} />
                      </div>
                      <div className="space-y-1">
                        <Label>Věk</Label>
                        <Input type="number" value={editData.age ?? ""} onChange={(e) => setEditData(p => ({ ...p, age: e.target.value ? Number(e.target.value) : null }))} />
                      </div>
                      <div className="space-y-1">
                        <Label>Pohlaví</Label>
                        <Input value={editData.gender || ""} onChange={(e) => setEditData(p => ({ ...p, gender: e.target.value }))} placeholder="muž / žena / jiné" />
                      </div>
                      <div className="space-y-1">
                        <Label>Typ terapie</Label>
                        <Input value={editData.therapy_type || ""} onChange={(e) => setEditData(p => ({ ...p, therapy_type: e.target.value }))} placeholder="individuální / rodinná / ..." />
                      </div>
                    </div>
                    <div className="space-y-1">
                      <Label>Diagnóza / pracovní hypotéza</Label>
                      <Textarea value={editData.diagnosis || ""} onChange={(e) => setEditData(p => ({ ...p, diagnosis: e.target.value }))} className="min-h-[60px]" />
                    </div>
                    <div className="space-y-1">
                      <Label>Zdroj doporučení</Label>
                      <Input value={editData.referral_source || ""} onChange={(e) => setEditData(p => ({ ...p, referral_source: e.target.value }))} />
                    </div>
                    <div className="space-y-1">
                      <Label>Klíčová anamnéza</Label>
                      <Textarea value={editData.key_history || ""} onChange={(e) => setEditData(p => ({ ...p, key_history: e.target.value }))} className="min-h-[80px]" />
                    </div>
                    <div className="space-y-1">
                      <Label>Rodinný kontext</Label>
                      <Textarea value={editData.family_context || ""} onChange={(e) => setEditData(p => ({ ...p, family_context: e.target.value }))} className="min-h-[80px]" />
                    </div>
                    <div className="space-y-1">
                      <Label>Poznámky</Label>
                      <Textarea value={editData.notes || ""} onChange={(e) => setEditData(p => ({ ...p, notes: e.target.value }))} className="min-h-[80px]" />
                    </div>
                  </>
                ) : (
                  <div className="space-y-3">
                    <CardField label="Věk" value={selectedClient.age ? `${selectedClient.age} let` : null} />
                    <CardField label="Pohlaví" value={selectedClient.gender} />
                    <CardField label="Diagnóza" value={selectedClient.diagnosis} />
                    <CardField label="Typ terapie" value={selectedClient.therapy_type} />
                    <CardField label="Zdroj doporučení" value={selectedClient.referral_source} />
                    <CardField label="Klíčová anamnéza" value={selectedClient.key_history} multiline />
                    <CardField label="Rodinný kontext" value={selectedClient.family_context} multiline />
                    <CardField label="Poznámky" value={selectedClient.notes} multiline />
                    {selectedClient.therapy_plan && (
                      <div className="pt-3 border-t border-border">
                        <div className="flex items-center justify-between mb-2">
                          <p className="text-xs font-semibold text-muted-foreground">TERAPEUTICKÝ PLÁN PROCESU</p>
                          <div className="flex gap-1">
                            <Button variant="outline" size="sm" className="h-6 text-[10px] gap-1 px-2"
                              onClick={() => {
                                import("@/lib/therapyPlanPdfExport").then(m => m.exportTherapyPlanPdf(selectedClient.name, selectedClient.therapy_plan));
                              }}>
                              <HardDriveDownload className="w-3 h-3" /> PDF
                            </Button>
                            <Button variant="outline" size="sm" className="h-6 text-[10px] gap-1 px-2"
                              onClick={() => setActiveTab("analysis")}>
                              <Edit3 className="w-3 h-3" /> Aktualizovat
                            </Button>
                          </div>
                        </div>
                        <div className="prose prose-sm max-w-none dark:prose-invert bg-secondary/20 rounded-lg p-3">
                          <ReactMarkdown>{selectedClient.therapy_plan}</ReactMarkdown>
                        </div>
                      </div>
                    )}
                    {!selectedClient.diagnosis && !selectedClient.therapy_type && !selectedClient.key_history && (
                      <p className="text-sm text-muted-foreground italic">Karta zatím není vyplněna. Klikni „Upravit" pro doplnění údajů.</p>
                    )}
                  </div>
                )}
              </div>

              {/* Analýzy karty */}
              <div className="bg-card rounded-xl border border-border p-4 sm:p-6">
                <div className="flex items-center gap-2 mb-3">
                  <Search className="w-4 h-4 text-muted-foreground" />
                  <h4 className="text-sm font-semibold">Analýzy karty ({clientAnalyses.length})</h4>
                </div>
                {clientAnalyses.length === 0 ? (
                  <p className="text-sm text-muted-foreground italic">Zatím žádné analýzy — vygeneruj ji v záložce Analýza.</p>
                ) : (
                  <Accordion type="single" collapsible defaultValue={clientAnalyses[0]?.id}>
                    {clientAnalyses.map((a: any) => {
                      let parsed: any = null;
                      try {
                        parsed = JSON.parse(a.content);
                        // Fix: if clientProfile contains embedded JSON block, extract it
                        if (typeof parsed?.clientProfile === "string" && parsed.clientProfile.includes("```json")) {
                          const match = parsed.clientProfile.match(/```json\s*([\s\S]*?)```/);
                          if (match) {
                            try {
                              const embedded = JSON.parse(match[1].trim());
                              const prefix = parsed.clientProfile.slice(0, parsed.clientProfile.indexOf("```json")).trim();
                              parsed = {
                                ...parsed,
                                clientProfile: embedded.clientProfile || prefix,
                                diagnosticHypothesis: embedded.diagnosticHypothesis || parsed.diagnosticHypothesis,
                                therapeuticProgress: embedded.therapeuticProgress || parsed.therapeuticProgress,
                                nextSessionRecommendations: embedded.nextSessionRecommendations || parsed.nextSessionRecommendations,
                                dataGaps: embedded.dataGaps || parsed.dataGaps,
                              };
                            } catch {}
                          }
                        }
                      } catch {}
                      const sessionsLabel = a.sessions_count != null ? ` (${a.sessions_count} sezení)` : "";
                      return (
                        <AccordionItem key={a.id} value={a.id}>
                          <div className="flex items-center">
                            <AccordionTrigger className="text-sm py-2 flex-1">
                              Analýza č. {a.version} – {new Date(a.created_at).toLocaleDateString("cs-CZ")}{sessionsLabel}
                            </AccordionTrigger>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-muted-foreground hover:text-destructive shrink-0"
                              onClick={(e) => {
                                e.stopPropagation();
                                if (confirm("Opravdu smazat tuto analýzu?")) {
                                  supabase.from("client_analyses" as any).delete().eq("id", a.id).then(() => {
                                    setClientAnalyses((prev: any[]) => prev.filter((x: any) => x.id !== a.id));
                                    toast.success("Analýza smazána");
                                  });
                                }
                              }}
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </Button>
                          </div>
                          <AccordionContent className="space-y-3">
                            <Tabs defaultValue="profile" className="space-y-3">
                              <TabsList className="grid w-full grid-cols-3 h-8">
                                <TabsTrigger value="profile" className="text-xs">Profil</TabsTrigger>
                                <TabsTrigger value="diagnosis" className="text-xs">Diagnostika</TabsTrigger>
                                <TabsTrigger value="next" className="text-xs">Co příště</TabsTrigger>
                              </TabsList>

                              <TabsContent value="profile" className="prose prose-sm max-w-none dark:prose-invert">
                                <ReactMarkdown>{parsed?.clientProfile || a.content}</ReactMarkdown>
                                {parsed?.therapeuticProgress && (
                                  <div className="mt-3 space-y-2 not-prose">
                                    {parsed.therapeuticProgress.whatWorks?.length > 0 && (
                                      <div>
                                        <p className="text-xs text-muted-foreground mb-1">✅ Co funguje:</p>
                                        {parsed.therapeuticProgress.whatWorks.map((w: string, i: number) => (
                                          <p key={i} className="text-sm">• {w}</p>
                                        ))}
                                      </div>
                                    )}
                                    {parsed.therapeuticProgress.whatDoesntWork?.length > 0 && (
                                      <div>
                                        <p className="text-xs text-muted-foreground mb-1">❌ Co nefunguje:</p>
                                        {parsed.therapeuticProgress.whatDoesntWork.map((w: string, i: number) => (
                                          <p key={i} className="text-sm">• {w}</p>
                                        ))}
                                      </div>
                                    )}
                                    {parsed?.therapeuticProgress?.clientDynamics && (
                                      <div>
                                        <p className="text-xs text-muted-foreground mb-1">Dynamika:</p>
                                        <p className="text-sm">{parsed.therapeuticProgress.clientDynamics}</p>
                                      </div>
                                    )}
                                  </div>
                                )}
                              </TabsContent>

                              <TabsContent value="diagnosis" className="space-y-3">
                                {parsed?.diagnosticHypothesis ? (
                                  <>
                                    <div>
                                      <p className="text-xs text-muted-foreground mb-1">Primární hypotéza:</p>
                                      <p className="text-sm font-medium">{parsed.diagnosticHypothesis.primary || "—"}</p>
                                      {parsed.diagnosticHypothesis.confidence && (
                                        <div className="flex items-center gap-2 mt-1">
                                          <span className="text-xs text-muted-foreground">Jistota:</span>
                                          <Badge variant={
                                            parsed.diagnosticHypothesis.confidence === "high" ? "default" :
                                            parsed.diagnosticHypothesis.confidence === "medium" ? "secondary" : "outline"
                                          } className="text-xs">
                                            {parsed.diagnosticHypothesis.confidence === "high" ? "● Vysoká" :
                                             parsed.diagnosticHypothesis.confidence === "medium" ? "● Střední" : "○ Nízká"}
                                          </Badge>
                                        </div>
                                      )}
                                    </div>
                                    {parsed.diagnosticHypothesis.differential?.length > 0 && (
                                      <div>
                                        <p className="text-xs text-muted-foreground mb-1">Diferenciální dg.:</p>
                                        <div className="flex flex-wrap gap-1.5">
                                          {parsed.diagnosticHypothesis.differential.map((d: string, i: number) => (
                                            <Badge key={i} variant="outline" className="text-xs">{d}</Badge>
                                          ))}
                                        </div>
                                      </div>
                                    )}
                                    {parsed.diagnosticHypothesis.supportingEvidence?.length > 0 && (
                                      <div>
                                        <p className="text-xs text-muted-foreground mb-1">Podpůrné důkazy:</p>
                                        {parsed.diagnosticHypothesis.supportingEvidence.map((e: string, i: number) => (
                                          <p key={i} className="text-sm">• {e}</p>
                                        ))}
                                      </div>
                                    )}
                                  </>
                                ) : (
                                  <p className="text-sm text-muted-foreground italic">Diagnostická data nejsou k dispozici.</p>
                                )}
                              </TabsContent>

                              <TabsContent value="next" className="space-y-3">
                                {parsed?.nextSessionRecommendations ? (
                                  <>
                                    {parsed.nextSessionRecommendations.focus?.length > 0 && (
                                      <div>
                                        <p className="text-xs text-muted-foreground mb-1">Zaměření:</p>
                                        {(Array.isArray(parsed.nextSessionRecommendations.focus)
                                          ? parsed.nextSessionRecommendations.focus
                                          : [parsed.nextSessionRecommendations.focus]
                                        ).map((f: string, i: number) => (
                                          <p key={i} className="text-sm">• {f}</p>
                                        ))}
                                      </div>
                                    )}
                                    {parsed.nextSessionRecommendations.suggestedTechniques?.length > 0 && (
                                      <div>
                                        <p className="text-xs text-muted-foreground mb-1">Doporučené techniky:</p>
                                        {parsed.nextSessionRecommendations.suggestedTechniques.map((t: string, i: number) => (
                                          <p key={i} className="text-sm">• {t}</p>
                                        ))}
                                      </div>
                                    )}
                                    {parsed.nextSessionRecommendations.diagnosticTests?.length > 0 && (
                                      <div>
                                        <p className="text-xs text-muted-foreground mb-1">Doporučené testy:</p>
                                        {parsed.nextSessionRecommendations.diagnosticTests.map((t: string, i: number) => (
                                          <p key={i} className="text-sm">• {t}</p>
                                        ))}
                                      </div>
                                    )}
                                    {parsed.nextSessionRecommendations.thingsToAsk?.length > 0 && (
                                      <div>
                                        <p className="text-xs text-muted-foreground mb-1">Otázky k položení:</p>
                                        {parsed.nextSessionRecommendations.thingsToAsk.map((q: string, i: number) => (
                                          <p key={i} className="text-sm">• {q}</p>
                                        ))}
                                      </div>
                                    )}
                                  </>
                                ) : (
                                  <p className="text-sm text-muted-foreground italic">Doporučení nejsou k dispozici.</p>
                                )}
                              </TabsContent>
                            </Tabs>

                            {parsed?.dataGaps?.length > 0 && (
                              <div className="border-t border-border pt-2">
                                <p className="text-xs text-muted-foreground mb-1">📌 Chybějící data:</p>
                                <div className="flex flex-wrap gap-1">
                                  {parsed.dataGaps.map((g: string, i: number) => (
                                    <Badge key={i} variant="outline" className="text-xs">{g}</Badge>
                                  ))}
                                </div>
                              </div>
                            )}
                          </AccordionContent>
                        </AccordionItem>
                      );
                    })}
                  </Accordion>
                )}
              </div>

              {/* Materiály ze sezení */}
              {sessionMaterials.length > 0 && (
                <div className="bg-card rounded-xl border border-border p-4 sm:p-6">
                  <div className="flex items-center gap-2 mb-3">
                    <ImageIcon className="w-4 h-4 text-muted-foreground" />
                    <h4 className="text-sm font-semibold">Materiály ze sezení ({sessionMaterials.length})</h4>
                  </div>
                  <div className="space-y-2">
                    {sessionMaterials.map((m: any) => (
                      <div key={m.id} className="flex items-center gap-3 p-2.5 bg-secondary/20 rounded-lg">
                        <div className="w-8 h-8 rounded bg-muted flex items-center justify-center shrink-0">
                          {m.material_type === "drawing" ? "🎨" : m.material_type === "handwriting" ? "✍️" : m.material_type === "document" ? "📄" : "📷"}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm truncate">{m.label || "Materiál"}</p>
                          <p className="text-xs text-muted-foreground">{new Date(m.created_at).toLocaleDateString("cs-CZ")}</p>
                        </div>
                        <Button variant="outline" size="sm" className="h-7 text-xs gap-1 shrink-0" onClick={() => setLightboxUrl(m.storage_url)}>
                          <Eye className="w-3 h-3" />
                          Zobrazit
                        </Button>
                        {m.analysis && (
                          <details className="shrink-0">
                            <summary className="text-xs text-primary cursor-pointer">Analýza</summary>
                            <div className="absolute z-10 bg-card border border-border rounded-lg p-3 shadow-lg max-w-xs mt-1 right-0">
                              <p className="text-xs whitespace-pre-wrap">{m.analysis}</p>
                            </div>
                          </details>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Lightbox dialog */}
              <Dialog open={!!lightboxUrl} onOpenChange={() => setLightboxUrl(null)}>
                <DialogContent className="max-w-3xl">
                  <DialogTitle>Materiál</DialogTitle>
                  <DialogDescription className="sr-only">Náhled nahraného materiálu</DialogDescription>
                  {lightboxUrl && (
                    <img src={lightboxUrl} alt="Materiál" className="w-full rounded-lg" />
                  )}
                </DialogContent>
              </Dialog>
            </TabsContent>

            {/* ─── ZÁZNAM SEZENÍ ─── */}
            <TabsContent value="intake" forceMount className={activeTab === "intake" ? "" : "hidden"}>
              <SessionIntakePanel
                clientId={selectedClient.id}
                clientName={selectedClient.name}
                onComplete={() => loadClientDetail(selectedClient)}
              />
            </TabsContent>

            {/* ─── SEZENÍ ─── */}
            <TabsContent value="sessions" forceMount className={activeTab === "sessions" ? "space-y-3" : "hidden"}>
              {sessions.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <FileText className="w-10 h-10 mx-auto mb-2 opacity-30" />
                  <p className="text-sm">Zatím žádné záznamy ze sezení.</p>
                  <p className="text-xs">Záznamy se vytvářejí automaticky z Report formuláře.</p>
                </div>
              ) : (
                sessions.map((s) => (
                  <div key={s.id} className="bg-card rounded-xl border border-border overflow-hidden">
                    <button
                      onClick={() => setExpandedSession(expandedSession === s.id ? null : s.id)}
                      className="w-full flex items-center gap-3 p-4 text-left hover:bg-secondary/30 transition-colors"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-sm">
                            Sezení {s.session_number ?? "?"}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {new Date(s.session_date).toLocaleDateString("cs-CZ")}
                          </span>
                        </div>
                        {s.report_key_theme && (
                          <p className="text-xs text-muted-foreground truncate mt-0.5">{s.report_key_theme}</p>
                        )}
                        {(() => {
                          const matCount = sessionMaterials.filter((m: any) => m.session_id === s.id).length;
                          return matCount > 0 ? (
                            <span className="text-xs text-primary flex items-center gap-0.5 mt-0.5">
                              <Paperclip className="w-3 h-3" /> Materiály ({matCount})
                            </span>
                          ) : null;
                        })()}
                      </div>
                      <ChevronRight className={`w-4 h-4 text-muted-foreground transition-transform ${expandedSession === s.id ? "rotate-90" : ""}`} />
                    </button>
                    {expandedSession === s.id && (
                      <div className="border-t border-border p-4 space-y-3 text-sm">
                        <SessionField label="Kontext" value={s.report_context} />
                        <SessionField label="Klíčové téma" value={s.report_key_theme} />
                        <SessionField label="Přenos / protipřenos" value={s.report_transference} />
                        <SessionField label="Intervence" value={s.report_interventions_tried} />
                        <SessionField label="Cíl dalšího sezení" value={s.report_next_session_goal} />
                        <SessionField label="Co ověřit" value={s.report_missing_data} />
                        {s.report_therapist_emotions?.length > 0 && (
                          <div>
                            <span className="text-muted-foreground text-xs">Emoce:</span>
                            <div className="flex flex-wrap gap-1 mt-1">
                              {s.report_therapist_emotions.map((e, i) => (
                                <Badge key={i} variant="outline" className="text-xs">{e}</Badge>
                              ))}
                            </div>
                          </div>
                        )}
                        {s.report_risks?.length > 0 && (
                          <div>
                            <span className="text-muted-foreground text-xs">Rizika:</span>
                            <div className="flex flex-wrap gap-1 mt-1">
                              {s.report_risks.map((r, i) => (
                                <Badge key={i} variant="destructive" className="text-xs">{r}</Badge>
                              ))}
                            </div>
                          </div>
                        )}
                        {s.ai_analysis && (
                          <div className="pt-2 border-t border-border">
                            <span className="text-muted-foreground text-xs">AI analýza:</span>
                            <SessionAnalysisView analysis={s.ai_analysis} />
                          </div>
                        )}
                        {s.voice_analysis && (
                          <div className="pt-2 border-t border-border">
                            <span className="text-muted-foreground text-xs">Hlasová analýza:</span>
                            <p className="text-sm mt-1 whitespace-pre-wrap">{s.voice_analysis}</p>
                          </div>
                        )}
                        {s.notes && (
                          <div className="pt-2 border-t border-border">
                            <span className="text-muted-foreground text-xs">Poznámky:</span>
                            <p className="text-sm mt-1 whitespace-pre-wrap">{s.notes}</p>
                          </div>
                        )}
                        <div className="pt-3 border-t border-border">
                          <Button
                            variant="outline"
                            size="sm"
                            className="gap-1.5 text-xs h-7"
                            onClick={() => {
                              if (!selectedClient) return;
                              exportSessionReportPdf(selectedClient.name, s)
                                .then(() => toast.success("PDF uloženo"))
                                .catch(() => toast.error("Chyba při exportu PDF"));
                            }}
                          >
                            <HardDriveDownload className="w-3 h-3" />
                            Exportovat PDF
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                ))
              )}
            </TabsContent>

            {/* ─── ÚKOLY ─── */}
            <TabsContent value="tasks" forceMount className={activeTab === "tasks" ? "" : "hidden"}>
              <ClientTasksPanel
                clientId={selectedClient.id}
                clientName={selectedClient.name}
                tasks={tasks}
                onRefresh={() => loadClientDetail(selectedClient)}
              />
            </TabsContent>

            {/* ─── ANALÝZA ─── */}
            <TabsContent value="analysis" forceMount className={activeTab === "analysis" ? "" : "hidden"}>
              <CardAnalysisPanel
                clientId={selectedClient.id}
                clientName={selectedClient.name}
                sessions={sessions}
                activePlan={activePlan}
                pendingTasks={tasks}
                existingTherapyPlan={selectedClient.therapy_plan}
                onRequestPlan={(analysis) => {
                  setCardAnalysis(analysis);
                }}
                onPlanSaved={(plan) => {
                  setSelectedClient(prev => prev ? { ...prev, therapy_plan: plan } : prev);
                }}
                onAnalysisSaved={(saved) => {
                  setClientAnalyses(prev => [saved, ...prev]);
                }}
              />
            </TabsContent>

            {/* ─── PŘIPRAVIT SEZENÍ ─── */}
            <TabsContent value="prep" forceMount className={activeTab === "prep" ? "" : "hidden"}>
              <ClientSessionPrepPanel
                clientId={selectedClient.id}
                clientName={selectedClient.name}
                sessions={sessions}
                onPlanApproved={(plan) => setActivePlan(plan)}
                onPlanDeleted={() => setActivePlan(null)}
                onStartSession={(plan) => {
                  const sessionId = createSession(selectedClient.id, selectedClient.name);
                  if (sessionId) {
                    updateSessionPlan(sessionId, plan);
                    setActiveTab("assistance");
                  }
                }}
              />
            </TabsContent>

            {/* ─── ASISTENCE ─── */}
            <TabsContent value="assistance" forceMount className={activeTab === "assistance" ? "" : "hidden"}>
              <LiveSessionPanel
                clientId={selectedClient.id}
                clientName={selectedClient.name}
                caseSummary={null}
                onEndSession={() => {
                  loadClientDetail(selectedClient);
                  setActiveTab("sessions");
                  toast.success("Zápis sezení uložen do záložky Sezení");
                }}
              />
            </TabsContent>

            {/* ─── ROZHOVOR ─── */}
            <TabsContent value="discussion" forceMount className={activeTab === "discussion" ? "" : "hidden"}>
              <ClientDiscussionChat clientId={selectedClient.id} clientName={selectedClient.name} />
            </TabsContent>
          </Tabs>
        </div>
      </ScrollArea>
    </div>
  );
};

// Helper components
const CardField = ({ label, value, multiline }: { label: string; value: string | null; multiline?: boolean }) => {
  if (!value) return null;
  return (
    <div>
      <span className="text-xs text-muted-foreground">{label}</span>
      {multiline ? (
        <p className="text-sm whitespace-pre-wrap mt-0.5">{value}</p>
      ) : (
        <p className="text-sm">{value}</p>
      )}
    </div>
  );
};

const SessionField = ({ label, value }: { label: string; value: string }) => {
  if (!value) return null;
  return (
    <div>
      <span className="text-muted-foreground text-xs">{label}:</span>
      <p className="text-sm whitespace-pre-wrap mt-0.5">{value}</p>
    </div>
  );
};

export default Kartoteka;
