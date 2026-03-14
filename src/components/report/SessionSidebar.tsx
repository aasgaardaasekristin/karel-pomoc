import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Plus, User, Trash2, UserPlus, Loader2, FolderOpen } from "lucide-react";
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
    <div className="w-full sm:w-48 md:w-56 shrink-0 border-b sm:border-b-0 sm:border-r border-border bg-card/50 flex flex-col h-auto sm:h-full max-h-[45svh] sm:max-h-none">
      <div className="p-3 border-b border-border">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            Sezení s klientem
          </h3>
          <span className="text-[10px] text-muted-foreground">({sessions.length}/5)</span>
        </div>

        {/* Quick add */}
        <div className="space-y-2">
          <Select value={selectedClientId} onValueChange={setSelectedClientId}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue placeholder="Klient..." />
            </SelectTrigger>
            <SelectContent>
              {clients.map(c => (
                <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" className="w-full h-8 text-xs" onClick={handleStartSession} disabled={!selectedClientId}>
            <Plus className="w-3.5 h-3.5 mr-1" /> Zahájit
          </Button>
          <div className="flex gap-1">
            <Input
              placeholder="Nový..."
              value={newClientName}
              onChange={e => setNewClientName(e.target.value)}
              className="h-8 text-xs"
              onKeyDown={e => { if (e.key === "Enter") handleCreateAndStart(); }}
            />
            <Button variant="outline" size="icon" className="h-8 w-8 shrink-0" onClick={handleCreateAndStart} disabled={!newClientName.trim() || isCreating}>
              {isCreating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UserPlus className="w-3.5 h-3.5" />}
            </Button>
          </div>
        </div>
      </div>

      {/* Session list */}
      <ScrollArea className="flex-1">
        <div className="p-2 space-y-1.5">
          {sessions.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-4">
              Žádná sezení.
            </p>
          ) : (
            [...sessions]
              .sort((a, b) => b.createdAt - a.createdAt)
              .map(s => (
                <div
                  key={s.id}
                  onClick={() => setActiveSession(s.id)}
                  className={`w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-left transition-all cursor-pointer group ${
                    s.id === activeSessionId
                      ? "bg-primary/10 border border-primary/30 text-foreground"
                      : "hover:bg-secondary/50 text-muted-foreground"
                  }`}
                >
                  <User className="w-3.5 h-3.5 shrink-0" />
                  <span className="truncate flex-1 text-xs font-medium">{s.clientName}</span>
                  <span className="text-[11px]">{statusLabel(s)}</span>
                  <button
                    onClick={(e) => handleDiscard(s, e)}
                    className="shrink-0 p-0.5 rounded hover:bg-destructive/10 transition-colors"
                    title="Zahodit sezení"
                  >
                    <Trash2 className="w-3.5 h-3.5 text-muted-foreground hover:text-destructive" />
                  </button>
                </div>
              ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
};

export default SessionSidebar;
