import { useState, useEffect } from "react";
import { RefreshCw, Loader2, Play, ListChecks, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";

interface UpdateLogEntry {
  id: string;
  part_name: string;
  sections_updated: string[];
  sections_skipped: string[];
  web_searches_performed: number;
  new_therapy_methods_added: number;
  contradictions_found: number;
  profile_updated: boolean;
  cross_writes: string[];
  processing_time_ms: number | null;
  error: string | null;
  created_at: string;
}

interface CrossWriteEntry {
  id: string;
  source_part: string;
  target_file: string;
  action: string;
  content: string;
  status: string;
  created_at: string;
}

export default function DidKartotekaTab() {
  const [logs, setLogs] = useState<UpdateLogEntry[]>([]);
  const [crossWrites, setCrossWrites] = useState<CrossWriteEntry[]>([]);
  const [unprocessedCount, setUnprocessedCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [expandedLog, setExpandedLog] = useState<string | null>(null);
  const [folders, setFolders] = useState<Array<{ id: string; name: string }>>([]);
  const [selectedFolder, setSelectedFolder] = useState<string>("");

  useEffect(() => { loadData(); }, []);

  async function loadData() {
    setLoading(true);
    try {
      const [logsRes, cwRes, threadsRes] = await Promise.all([
        supabase.from("card_update_log").select("*").order("created_at", { ascending: false }).limit(20),
        supabase.from("card_crosswrite_queue").select("*").order("created_at", { ascending: false }).limit(20),
        supabase.from("did_conversations")
          .select("id", { count: "exact", head: true })
          .eq("sub_mode", "cast")
          .eq("is_processed", false),
      ]);

      if (logsRes.data) setLogs(logsRes.data as any[]);
      if (cwRes.data) setCrossWrites(cwRes.data as any[]);
      setUnprocessedCount(threadsRes.count ?? 0);

      // Load folders for single-part update
      const { data: folderData } = await supabase.functions.invoke("cleanup-part-card", {
        body: { listOnly: true },
      });
      if (folderData?.folders) setFolders(folderData.folders);
    } catch (e) {
      console.error("Load error:", e);
    }
    setLoading(false);
  }

  async function runFullUpdate() {
    setUpdating(true);
    toast.info("Spouštím aktualizaci všech karet...");
    try {
      const { data, error } = await supabase.functions.invoke("run-daily-card-updates", { body: {} });
      if (error) throw error;
      toast.success(`Hotovo: ${data?.partsProcessed || 0} karet zpracováno`);
      loadData();
    } catch (e) {
      toast.error(`Chyba: ${e}`);
    }
    setUpdating(false);
  }

  async function runSingleUpdate() {
    if (!selectedFolder) { toast.warning("Vyber část"); return; }
    const folder = folders.find(f => f.id === selectedFolder);
    if (!folder) return;
    setUpdating(true);
    toast.info(`Aktualizuji ${folder.name}...`);
    try {
      const { data, error } = await supabase.functions.invoke("run-daily-card-updates", {
        body: { partName: folder.name.replace(/^\d+_/, "") },
      });
      if (error) throw error;
      toast.success(`Hotovo: ${data?.partsProcessed || 0} karet zpracováno`);
      loadData();
    } catch (e) {
      toast.error(`Chyba: ${e}`);
    }
    setUpdating(false);
  }

  const formatTime = (ms: number | null) => {
    if (!ms) return "—";
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  };

  const formatDate = (iso: string) => {
    const d = new Date(iso);
    return `${d.toLocaleDateString("cs")} ${d.toLocaleTimeString("cs", { hour: "2-digit", minute: "2-digit" })}`;
  };

  return (
    <div className="space-y-4">
      {/* Unprocessed threads indicator */}
      <div className="flex items-center justify-between p-2 rounded-md bg-muted/50">
        <span className="text-xs text-muted-foreground">
          Nezpracovaná vlákna: <strong className={unprocessedCount > 0 ? "text-amber-600" : "text-foreground"}>{unprocessedCount}</strong>
        </span>
        <Button size="sm" variant="ghost" className="h-6 text-[10px]" onClick={loadData} disabled={loading}>
          {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
        </Button>
      </div>

      {/* Manual triggers */}
      <div className="space-y-2">
        <Button
          onClick={runFullUpdate}
          disabled={updating}
          className="w-full h-9 text-xs gap-2"
          variant="default"
        >
          {updating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
          🔄 Spustit aktualizaci všech karet
        </Button>

        <div className="flex gap-2">
          <select
            value={selectedFolder}
            onChange={e => setSelectedFolder(e.target.value)}
            className="flex-1 h-8 text-xs rounded-md border bg-background px-2"
          >
            <option value="">Vyber část...</option>
            {folders.map(f => (
              <option key={f.id} value={f.id}>{f.name}</option>
            ))}
          </select>
          <Button size="sm" variant="outline" className="h-8 text-xs" onClick={runSingleUpdate} disabled={updating || !selectedFolder}>
            Aktualizovat
          </Button>
        </div>
      </div>

      {/* Update log */}
      <div>
        <h4 className="text-xs font-medium mb-2 flex items-center gap-1.5">
          <ListChecks className="w-3.5 h-3.5" /> Poslední aktualizace
        </h4>
        {logs.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-4">Zatím žádné aktualizace</p>
        ) : (
          <div className="space-y-1.5 max-h-60 overflow-y-auto">
            {logs.map(log => (
              <div
                key={log.id}
                className={`p-2 rounded-md border text-[10px] cursor-pointer transition-colors ${
                  log.error ? "border-destructive/30 bg-destructive/5" : "border-border hover:bg-muted/30"
                }`}
                onClick={() => setExpandedLog(expandedLog === log.id ? null : log.id)}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{log.part_name}</span>
                    {log.error && <AlertTriangle className="w-3 h-3 text-destructive" />}
                    {log.contradictions_found > 0 && (
                      <Badge variant="secondary" className="h-4 text-[8px] px-1">⚠️ {log.contradictions_found} rozporů</Badge>
                    )}
                    {log.new_therapy_methods_added > 0 && (
                      <Badge variant="secondary" className="h-4 text-[8px] px-1">+{log.new_therapy_methods_added} metod</Badge>
                    )}
                  </div>
                  <span className="text-muted-foreground">{formatDate(log.created_at)}</span>
                </div>

                {expandedLog === log.id && (
                  <div className="mt-2 pt-2 border-t space-y-1">
                    <p><span className="text-muted-foreground">Sekce aktualizovány:</span> {log.sections_updated?.join(", ") || "—"}</p>
                    <p><span className="text-muted-foreground">Sekce beze změny:</span> {log.sections_skipped?.join(", ") || "—"}</p>
                    <p><span className="text-muted-foreground">Web searchů:</span> {log.web_searches_performed}</p>
                    <p><span className="text-muted-foreground">Profilace:</span> {log.profile_updated ? "✅" : "—"}</p>
                    <p><span className="text-muted-foreground">Cross-writes:</span> {log.cross_writes?.join(", ") || "—"}</p>
                    <p><span className="text-muted-foreground">Čas:</span> {formatTime(log.processing_time_ms)}</p>
                    {log.error && <p className="text-destructive">{log.error}</p>}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Cross-write queue */}
      <div>
        <h4 className="text-xs font-medium mb-2">📝 Cross-write fronta</h4>
        {crossWrites.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-2">Prázdná fronta</p>
        ) : (
          <div className="space-y-1 max-h-40 overflow-y-auto">
            {crossWrites.map(cw => (
              <div key={cw.id} className="flex items-center justify-between p-1.5 rounded border text-[10px]">
                <div>
                  <span className="font-medium">{cw.source_part}</span>
                  <span className="text-muted-foreground"> → {cw.target_file}</span>
                </div>
                <Badge variant={cw.status === "done" ? "default" : cw.status === "pending" ? "secondary" : "destructive"} className="h-4 text-[8px]">
                  {cw.status}
                </Badge>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
