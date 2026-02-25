import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Plus, User, X, UserPlus, Loader2 } from "lucide-react";
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
    const fetch = async () => {
      const { data } = await supabase.from("clients").select("id, name").order("name");
      if (data) setClients(data);
    };
    fetch();
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

  const statusLabel = (s: SessionWorkspace) => {
    if (s.status === "report-ready") return "📋";
    if (s.reportText) return "✅";
    return "✏️";
  };

  return (
    <div className="w-64 shrink-0 border-r border-border bg-card/50 flex flex-col h-full">
      <div className="p-3 border-b border-border">
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
          Aktivní sezení ({sessions.length}/5)
        </h3>

        {/* Quick add */}
        <div className="space-y-2">
          <Select value={selectedClientId} onValueChange={setSelectedClientId}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue placeholder="Vybrat klienta..." />
            </SelectTrigger>
            <SelectContent>
              {clients.map(c => (
                <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" className="w-full h-7 text-xs" onClick={handleStartSession} disabled={!selectedClientId}>
            <Plus className="w-3 h-3 mr-1" /> Zahájit sezení
          </Button>
          <div className="flex gap-1">
            <Input
              placeholder="Nový klient..."
              value={newClientName}
              onChange={e => setNewClientName(e.target.value)}
              className="h-7 text-xs"
              onKeyDown={e => { if (e.key === "Enter") handleCreateAndStart(); }}
            />
            <Button variant="outline" size="icon" className="h-7 w-7 shrink-0" onClick={handleCreateAndStart} disabled={!newClientName.trim() || isCreating}>
              {isCreating ? <Loader2 className="w-3 h-3 animate-spin" /> : <UserPlus className="w-3 h-3" />}
            </Button>
          </div>
        </div>
      </div>

      {/* Session list */}
      <ScrollArea className="flex-1">
        <div className="p-2 space-y-1">
          {sessions.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-4">
              Žádná aktivní sezení.<br />Vyber klienta výše.
            </p>
          ) : (
            sessions.map(s => (
              <button
                key={s.id}
                onClick={() => setActiveSession(s.id)}
                className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left text-sm transition-all group ${
                  s.id === activeSessionId
                    ? "bg-primary/10 border border-primary/30 text-foreground"
                    : "hover:bg-secondary/50 text-muted-foreground"
                }`}
              >
                <User className="w-3.5 h-3.5 shrink-0" />
                <span className="truncate flex-1 text-xs font-medium">{s.clientName}</span>
                <span className="text-xs">{statusLabel(s)}</span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    if (confirm(`Zavřít sezení s ${s.clientName}? Neuložená data budou ztracena.`)) {
                      removeSession(s.id);
                    }
                  }}
                  className="opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <X className="w-3 h-3 text-muted-foreground hover:text-destructive" />
                </button>
              </button>
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
};

export default SessionSidebar;
