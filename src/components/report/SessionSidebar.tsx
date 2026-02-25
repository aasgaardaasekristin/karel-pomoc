import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Plus, User, Trash2, UserPlus, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { useActiveSessions, SessionWorkspace } from "@/contexts/ActiveSessionsContext";

type ClientOption = { id: string; name: string };

const SessionSidebar = () => {
  const {
    sessions,
    activeSessionId,
    setActiveSession,
    createSession,
    removeSession,
  } = useActiveSessions();

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
    <div className="w-36 sm:w-48 md:w-56 shrink-0 border-r border-border bg-card/50 flex flex-col h-full">
      <div className="p-2 md:p-3 border-b border-border">
        <h3 className="text-[10px] md:text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
          Sezení ({sessions.length}/5)
        </h3>

        {/* Quick add */}
        <div className="space-y-1.5">
          <Select value={selectedClientId} onValueChange={setSelectedClientId}>
            <SelectTrigger className="h-7 text-[10px] md:text-xs">
              <SelectValue placeholder="Klient..." />
            </SelectTrigger>
            <SelectContent>
              {clients.map(c => (
                <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" className="w-full h-6 md:h-7 text-[10px] md:text-xs" onClick={handleStartSession} disabled={!selectedClientId}>
            <Plus className="w-3 h-3 mr-1" /> Zahájit
          </Button>
          <div className="flex gap-1">
            <Input
              placeholder="Nový..."
              value={newClientName}
              onChange={e => setNewClientName(e.target.value)}
              className="h-6 md:h-7 text-[10px] md:text-xs"
              onKeyDown={e => { if (e.key === "Enter") handleCreateAndStart(); }}
            />
            <Button variant="outline" size="icon" className="h-6 w-6 md:h-7 md:w-7 shrink-0" onClick={handleCreateAndStart} disabled={!newClientName.trim() || isCreating}>
              {isCreating ? <Loader2 className="w-3 h-3 animate-spin" /> : <UserPlus className="w-3 h-3" />}
            </Button>
          </div>
        </div>
      </div>

      {/* Session list */}
      <ScrollArea className="flex-1">
        <div className="p-1.5 space-y-1">
          {sessions.length === 0 ? (
            <p className="text-[10px] md:text-xs text-muted-foreground text-center py-4">
              Žádná sezení.
            </p>
          ) : (
            sessions.map(s => (
              <div
                key={s.id}
                onClick={() => setActiveSession(s.id)}
                className={`w-full flex items-center gap-1 md:gap-2 px-2 py-1.5 md:py-2 rounded-lg text-left transition-all cursor-pointer group ${
                  s.id === activeSessionId
                    ? "bg-primary/10 border border-primary/30 text-foreground"
                    : "hover:bg-secondary/50 text-muted-foreground"
                }`}
              >
                <User className="w-3 h-3 shrink-0" />
                <span className="truncate flex-1 text-[10px] md:text-xs font-medium">{s.clientName}</span>
                <span className="text-[10px]">{statusLabel(s)}</span>
                <button
                  onClick={(e) => handleDiscard(s, e)}
                  className="shrink-0 p-0.5 rounded hover:bg-destructive/10 transition-colors"
                  title="Zahodit sezení"
                >
                  <Trash2 className="w-3 h-3 text-muted-foreground hover:text-destructive" />
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
