import { useState, useEffect, useCallback } from "react";
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
} from "lucide-react";
import { toast } from "sonner";
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
  const { createSession, updateSessionPlan, sessions: activeSessions } = useActiveSessions();
  const { setMainMode } = useChatContext();
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

  const handleTabChange = (value: string) => {
    setActiveTab(value);
    if (value === "assistance" && selectedClient) {
      const existingSession = activeSessions?.find(s => s.clientId === selectedClient.id);
      if (!existingSession) {
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

  // Fetch client detail
  const loadClientDetail = useCallback(async (client: Client) => {
    setSelectedClient(client);
    setIsEditing(false);

    const [sessionsRes, tasksRes] = await Promise.all([
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
    ]);

    if (sessionsRes.data) setSessions(sessionsRes.data as ClientSession[]);
    if (tasksRes.data) setTasks(tasksRes.data as ClientTask[]);
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
            {!isEditing ? (
              <Button variant="outline" size="sm" onClick={() => { setIsEditing(true); setEditData(selectedClient); }} className="h-8">
                <Edit3 className="w-3.5 h-3.5 sm:mr-1" />
                <span className="hidden sm:inline">Upravit</span>
              </Button>
            ) : (
              <>
                <Button size="sm" onClick={handleSaveClient} className="h-8">
                  <Save className="w-3.5 h-3.5 sm:mr-1" />
                  <span className="hidden sm:inline">Uložit</span>
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setIsEditing(false)} className="h-8">
                  <X className="w-3.5 h-3.5" />
                </Button>
              </>
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
            <div className="overflow-x-auto -mx-3 px-3">
              <TabsList className="inline-flex w-auto min-w-full sm:grid sm:grid-cols-8 h-auto flex-nowrap">
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
                <TabsTrigger value="analysis" className="gap-1 text-[11px] sm:text-sm px-2 sm:px-3 whitespace-nowrap">
                  Analýza
                </TabsTrigger>
                <TabsTrigger value="prep" className="gap-1 text-[11px] sm:text-sm px-2 sm:px-3 whitespace-nowrap">
                  Připravit sezení
                </TabsTrigger>
                <TabsTrigger value="assistance" className="gap-1 text-[11px] sm:text-sm px-2 sm:px-3 whitespace-nowrap">
                  Asistence
                </TabsTrigger>
                <TabsTrigger value="discussion" className="gap-1 text-[11px] sm:text-sm px-2 sm:px-3 whitespace-nowrap">
                  <MessageSquare className="w-3.5 h-3.5 hidden sm:block" />
                  Rozhovor
                </TabsTrigger>
              </TabsList>
            </div>

            {/* ─── KARTA ─── */}
            <TabsContent value="card" className="space-y-4">
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
                    {!selectedClient.diagnosis && !selectedClient.therapy_type && !selectedClient.key_history && (
                      <p className="text-sm text-muted-foreground italic">Karta zatím není vyplněna. Klikni „Upravit" pro doplnění údajů.</p>
                    )}
                  </div>
                )}
              </div>
            </TabsContent>

            {/* ─── ZÁZNAM SEZENÍ ─── */}
            <TabsContent value="intake">
              <SessionIntakePanel
                clientId={selectedClient.id}
                clientName={selectedClient.name}
                onComplete={() => loadClientDetail(selectedClient)}
              />
            </TabsContent>

            {/* ─── SEZENÍ ─── */}
            <TabsContent value="sessions" className="space-y-3">
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
                            <p className="text-sm mt-1 whitespace-pre-wrap">{s.ai_analysis}</p>
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
            <TabsContent value="tasks">
              <ClientTasksPanel
                clientId={selectedClient.id}
                clientName={selectedClient.name}
                tasks={tasks}
                onRefresh={() => loadClientDetail(selectedClient)}
              />
            </TabsContent>

            {/* ─── ANALÝZA ─── */}
            <TabsContent value="analysis">
              <CardAnalysisPanel
                clientId={selectedClient.id}
                clientName={selectedClient.name}
                sessions={sessions}
                activePlan={activePlan}
                pendingTasks={tasks}
                onRequestPlan={(analysis) => {
                  setCardAnalysis(analysis);
                }}
              />
            </TabsContent>

            {/* ─── PŘIPRAVIT SEZENÍ ─── */}
            <TabsContent value="prep">
              <ClientSessionPrepPanel
                clientId={selectedClient.id}
                clientName={selectedClient.name}
                sessions={sessions}
                onPlanApproved={(plan) => setActivePlan(plan)}
                onPlanDeleted={() => setActivePlan(null)}
                onStartSession={(plan) => {
                  try {
                    const sessionId = createSession(selectedClient.id, selectedClient.name);
                    updateSessionPlan(sessionId, plan);
                    sessionStorage.setItem("karel_hub_section", "hana");
                    setMainMode("report");
                    navigate("/chat");
                  } catch (e: any) {
                    toast.error(e.message || "Chyba při vytváření sezení");
                  }
                }}
              />
            </TabsContent>

            {/* ─── ROZHOVOR ─── */}
            <TabsContent value="discussion">
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
