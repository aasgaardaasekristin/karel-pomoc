import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Plus, User, Trash2, UserPlus, Loader2, FolderOpen, Sparkles } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { useActiveSessions, SessionWorkspace } from "@/contexts/ActiveSessionsContext";
import { useNavigate } from "react-router-dom";

type ClientOption = { id: string; name: string };

const SessionSidebar = () => {
  const {
    sessions,
    activeSessionId,
    setActiveSession,
    createSession,
    removeSession,
  } = useActiveSessions();
  const navigate = useNavigate();

  const [clients, setClients] = useState<ClientOption[]>([]);
  const [selectedClientId, setSelectedClientId] = useState("");
  const [newClientName, setNewClientName] = useState("");
  const [isCreating, setIsCreating] = useState(false);

  useEffect(() => {
    const fetchClients = async () => {
      const { data } = await supabase.from("clients").select("id, name").order("name");
      if (data) setClients(data);
    };
    fetchClients();
  }, []);

  const handleStartSession = () => {
    if (!selectedClientId) return;
    const client = clients.find(c => c.id === selectedClientId);
    if (!client) return;
    try {
      createSession(client.id, client.name);
      setSelectedClientId("");
    } catch (e: any) {
      toast.error(e.message);
    }
  };

  const handleCreateAndStart = async () => {
    if (!newClientName.trim()) return;
    setIsCreating(true);
    try {
      const { data, error } = await supabase
        .from("clients")
        .insert({ name: newClientName.trim() })
        .select("id, name")
        .single();
      if (error) throw error;
      if (data) {
        setClients(prev => [...prev, data].sort((a, b) => a.name.localeCompare(b.name)));
        createSession(data.id, data.name);
        setNewClientName("");
        toast.success(`Klient „${data.name}" vytvořen`);
      }
    } catch {
      toast.error("Nepodařilo se vytvořit klienta");
    } finally {
      setIsCreating(false);
    }
  };

  const handleDiscard = (s: SessionWorkspace, e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirm(`Zahodit sezení s ${s.clientName}? Nic se neuloží do kartotéky.`)) {
      removeSession(s.id);
      toast.info(`Sezení s ${s.clientName} zahozeno`);
    }
  };

  const statusLabel = (s: SessionWorkspace) => {
    if (s.status === "report-ready") return "📋";
    if (s.reportText) return "✅";
    return "✏️";
  };

  return (
    <ScrollArea className="flex-1">
      <div className="max-w-xl mx-auto px-4 py-8 sm:py-12 space-y-8">
        {/* Hero section */}
        <div className="text-center space-y-3">
          <div className="w-14 h-14 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto">
            <Sparkles className="w-7 h-7 text-primary" />
          </div>
          <h2 className="text-xl sm:text-2xl font-serif font-semibold text-foreground">
            Sezení s klientem
          </h2>
          <p className="text-sm text-muted-foreground max-w-sm mx-auto">
            Vyber existujícího klienta z kartotéky nebo zadej jméno nového klienta pro zahájení sezení.
          </p>
        </div>

        {/* Client selection card */}
        <div className="bg-card border border-border rounded-xl p-5 sm:p-6 space-y-4 shadow-sm">
          <h3 className="text-sm font-medium text-foreground">Vybrat klienta</h3>
          <Select value={selectedClientId} onValueChange={setSelectedClientId}>
            <SelectTrigger className="h-10 text-sm">
              <SelectValue placeholder="Vyberte klienta z kartotéky..." />
            </SelectTrigger>
            <SelectContent>
              {clients.map(c => (
                <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button className="w-full h-10 gap-2" onClick={handleStartSession} disabled={!selectedClientId}>
            <Plus className="w-4 h-4" /> Zahájit sezení
          </Button>

          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <span className="w-full border-t border-border" />
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-card px-3 text-muted-foreground">nebo nový klient</span>
            </div>
          </div>

          <div className="flex gap-2">
            <Input
              placeholder="Jméno nového klienta..."
              value={newClientName}
              onChange={e => setNewClientName(e.target.value)}
              className="h-10 text-sm flex-1"
              onKeyDown={e => { if (e.key === "Enter") handleCreateAndStart(); }}
            />
            <Button variant="outline" size="icon" className="h-10 w-10 shrink-0" onClick={handleCreateAndStart} disabled={!newClientName.trim() || isCreating}>
              {isCreating ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserPlus className="w-4 h-4" />}
            </Button>
          </div>
        </div>

        {/* Kartotéka shortcut */}
        <Button 
          variant="outline" 
          onClick={() => navigate("/kartoteka")} 
          className="w-full h-10 gap-2 text-sm"
        >
          <FolderOpen className="w-4 h-4" />
          Otevřít kartotéku
        </Button>

        {/* Active sessions */}
        {sessions.length > 0 && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Rozpracovaná sezení
              </h3>
              <span className="text-[10px] text-muted-foreground">{sessions.length}/5</span>
            </div>
            <div className="space-y-2">
              {[...sessions]
                .sort((a, b) => b.createdAt - a.createdAt)
                .map(s => (
                  <div
                    key={s.id}
                    onClick={() => setActiveSession(s.id)}
                    className={`flex items-center gap-3 px-4 py-3 rounded-xl border transition-all cursor-pointer group ${
                      s.id === activeSessionId
                        ? "bg-primary/5 border-primary/30 text-foreground shadow-sm"
                        : "bg-card border-border hover:border-primary/20 hover:bg-card/80 text-muted-foreground"
                    }`}
                  >
                    <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                      <User className="w-4 h-4 text-primary" />
                    </div>
                    <span className="truncate flex-1 text-sm font-medium">{s.clientName}</span>
                    <span className="text-sm">{statusLabel(s)}</span>
                    <button
                      onClick={(e) => handleDiscard(s, e)}
                      className="shrink-0 p-1.5 rounded-lg hover:bg-destructive/10 transition-colors opacity-0 group-hover:opacity-100"
                      title="Zahodit sezení"
                    >
                      <Trash2 className="w-3.5 h-3.5 text-muted-foreground hover:text-destructive" />
                    </button>
                  </div>
                ))}
            </div>
          </div>
        )}
      </div>
    </ScrollArea>
  );
};

export default SessionSidebar;
