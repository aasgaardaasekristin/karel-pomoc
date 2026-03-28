import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, Pencil, Trash2, Check, X, Filter, Shuffle } from "lucide-react";
import { toast } from "sonner";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

interface SessionMemory {
  id: string;
  part_name: string;
  session_date: string;
  key_points: string[];
  emotional_state: string | null;
  topics: string[];
  unresolved: string[];
  promises: string[];
  risk_signals: string[];
  positive_signals: string[];
  session_mode: string | null;
  session_duration_msgs: number;
  manually_edited: boolean;
}

interface Promise {
  id: string;
  part_name: string;
  promise_text: string;
  context: string | null;
  status: string;
  created_at: string;
}

interface SwitchingEvent {
  id: string;
  thread_id: string;
  original_part: string;
  detected_part: string;
  confidence: string;
  signals: any;
  user_message_excerpt: string | null;
  acknowledged: boolean;
  created_at: string;
}

const DidMemoryTab = () => {
  const [memories, setMemories] = useState<SessionMemory[]>([]);
  const [promises, setPromises] = useState<Promise[]>([]);
  const [loading, setLoading] = useState(true);
  const [partFilter, setPartFilter] = useState<string>("all");
  const [allParts, setAllParts] = useState<string[]>([]);
  const [editingMemory, setEditingMemory] = useState<SessionMemory | null>(null);
  const [editForm, setEditForm] = useState({ key_points: "", emotional_state: "", unresolved: "", topics: "" });

  const loadData = useCallback(async () => {
    setLoading(true);
    let memQuery = supabase.from("session_memory")
      .select("*")
      .order("session_date", { ascending: false })
      .limit(30);
    if (partFilter !== "all") memQuery = memQuery.eq("part_name", partFilter);
    
    const [memRes, promRes] = await window.Promise.all([
      memQuery,
      supabase.from("karel_promises").select("*").eq("status", "active").order("created_at", { ascending: false }),
    ]);

    setMemories((memRes.data || []) as SessionMemory[]);
    setPromises((promRes.data || []) as Promise[]);

    // Collect unique part names
    if (partFilter === "all" && memRes.data?.length) {
      const parts = [...new Set(memRes.data.map((m: any) => m.part_name))];
      setAllParts(parts);
    }
    setLoading(false);
  }, [partFilter]);

  useEffect(() => { loadData(); }, [loadData]);

  const handleEdit = (mem: SessionMemory) => {
    setEditingMemory(mem);
    setEditForm({
      key_points: (mem.key_points || []).join("\n"),
      emotional_state: mem.emotional_state || "",
      unresolved: (mem.unresolved || []).join("\n"),
      topics: (mem.topics || []).join(", "),
    });
  };

  const handleSaveEdit = async () => {
    if (!editingMemory) return;
    const { error } = await supabase.from("session_memory").update({
      key_points: editForm.key_points.split("\n").filter(Boolean),
      emotional_state: editForm.emotional_state || null,
      unresolved: editForm.unresolved.split("\n").filter(Boolean),
      topics: editForm.topics.split(",").map(t => t.trim()).filter(Boolean),
      manually_edited: true,
    }).eq("id", editingMemory.id);
    if (error) { toast.error("Chyba při ukládání"); return; }
    toast.success("Paměť aktualizována");
    setEditingMemory(null);
    loadData();
  };

  const handleDelete = async (id: string) => {
    await supabase.from("session_memory").update({
      key_points: ["SMAZÁNO"],
      manually_edited: true,
    }).eq("id", id);
    toast.success("Smazáno");
    loadData();
  };

  const handlePromiseAction = async (id: string, status: "fulfilled" | "cancelled") => {
    await supabase.from("karel_promises").update({
      status,
      fulfilled_at: status === "fulfilled" ? new Date().toISOString() : null,
    }).eq("id", id);
    toast.success(status === "fulfilled" ? "Slib splněn ✅" : "Slib zrušen");
    loadData();
  };

  if (loading) return <div className="flex justify-center py-6"><Loader2 className="w-5 h-5 animate-spin" /></div>;

  return (
    <div className="space-y-4">
      {/* Filter */}
      <div className="flex items-center gap-2">
        <Filter className="w-3.5 h-3.5 text-muted-foreground" />
        <select
          value={partFilter}
          onChange={e => setPartFilter(e.target.value)}
          className="text-xs bg-muted rounded px-2 py-1 border-none"
        >
          <option value="all">Všechny části</option>
          {allParts.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
      </div>

      {/* Memories */}
      {memories.length === 0 ? (
        <p className="text-xs text-muted-foreground text-center py-4">Zatím žádná paměť ze sezení.</p>
      ) : (
        <div className="space-y-2">
          {memories.map(mem => {
            const hasRisk = (mem.risk_signals || []).length > 0;
            const hasPositive = (mem.positive_signals || []).length > 0;
            const borderColor = hasRisk ? "border-l-destructive" : hasPositive ? "border-l-emerald-500" : "border-l-border";

            return (
              <div key={mem.id} className={`rounded-lg border border-border ${borderColor} border-l-4 p-3 space-y-1.5`}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium">🧠 {mem.part_name}</span>
                    <span className="text-[10px] text-muted-foreground">
                      {new Date(mem.session_date).toLocaleDateString("cs")}
                    </span>
                  </div>
                  <div className="flex items-center gap-1">
                    {mem.emotional_state && (
                      <Badge variant="outline" className="text-[9px] h-4 px-1.5">{mem.emotional_state}</Badge>
                    )}
                    <button onClick={() => handleEdit(mem)} className="p-1 hover:bg-muted rounded">
                      <Pencil className="w-3 h-3 text-muted-foreground" />
                    </button>
                    <button onClick={() => handleDelete(mem.id)} className="p-1 hover:bg-muted rounded">
                      <Trash2 className="w-3 h-3 text-muted-foreground" />
                    </button>
                  </div>
                </div>

                {(mem.key_points || []).filter(p => p !== "SMAZÁNO").map((point, i) => (
                  <p key={i} className="text-[11px] text-foreground">• {point}</p>
                ))}

                {(mem.unresolved || []).length > 0 && (
                  <div className="text-[11px] text-amber-600">
                    {mem.unresolved.map((u, i) => <p key={i}>⚠️ Nedořešené: {u}</p>)}
                  </div>
                )}

                {(mem.promises || []).length > 0 && (
                  <div className="text-[11px] text-primary">
                    {mem.promises.map((p, i) => <p key={i}>🤝 Slíbeno: {p}</p>)}
                  </div>
                )}

                {(mem.topics || []).length > 0 && (
                  <div className="flex gap-1 flex-wrap mt-1">
                    {mem.topics.map((t, i) => (
                      <Badge key={i} variant="secondary" className="text-[8px] h-3.5 px-1">{t}</Badge>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Active Promises */}
      {promises.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-xs font-medium">🤝 Aktivní sliby Karla</h3>
          {promises.map(p => (
            <div key={p.id} className="flex items-center justify-between border rounded-md px-3 py-2">
              <div className="flex-1 min-w-0">
                <p className="text-[11px] text-foreground truncate">{p.promise_text}</p>
                <p className="text-[9px] text-muted-foreground">{p.part_name} — od {new Date(p.created_at).toLocaleDateString("cs")}</p>
              </div>
              <div className="flex gap-1 ml-2 shrink-0">
                <Button size="sm" variant="outline" className="h-6 px-1.5 text-[9px]" onClick={() => handlePromiseAction(p.id, "fulfilled")}>
                  <Check className="w-3 h-3" /> Splněno
                </Button>
                <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[9px]" onClick={() => handlePromiseAction(p.id, "cancelled")}>
                  <X className="w-3 h-3" /> Zrušit
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Edit Dialog */}
      <Dialog open={!!editingMemory} onOpenChange={() => setEditingMemory(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle className="text-sm">Upravit paměť</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-xs font-medium">Body (každý řádek = 1 bod)</label>
              <Textarea value={editForm.key_points} onChange={e => setEditForm(f => ({ ...f, key_points: e.target.value }))} className="text-xs min-h-[80px]" />
            </div>
            <div>
              <label className="text-xs font-medium">Emoční stav</label>
              <input value={editForm.emotional_state} onChange={e => setEditForm(f => ({ ...f, emotional_state: e.target.value }))} className="w-full text-xs border rounded px-2 py-1.5" />
            </div>
            <div>
              <label className="text-xs font-medium">Nedořešené (každý řádek)</label>
              <Textarea value={editForm.unresolved} onChange={e => setEditForm(f => ({ ...f, unresolved: e.target.value }))} className="text-xs min-h-[60px]" />
            </div>
            <div>
              <label className="text-xs font-medium">Témata (čárkou)</label>
              <input value={editForm.topics} onChange={e => setEditForm(f => ({ ...f, topics: e.target.value }))} className="w-full text-xs border rounded px-2 py-1.5" />
            </div>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={() => setEditingMemory(null)}>Zrušit</Button>
              <Button size="sm" onClick={handleSaveEdit}>Uložit</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default DidMemoryTab;
