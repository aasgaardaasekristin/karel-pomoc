import { useState, useEffect } from "react";
import { Loader2, Sparkles, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";

interface PartFolder {
  id: string;
  name: string;
}

interface CleanupResult {
  cardName: string;
  originalSize: number;
  cleanedSize: number;
  log: {
    duplicatesRemoved: number;
    testsRemoved: number;
    redistributionsIntegrated: number;
    movedToOtherCard: number;
    movedEntityNames: string[];
  };
}

export default function DidCardCleanup() {
  const [folders, setFolders] = useState<PartFolder[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedFolder, setSelectedFolder] = useState<PartFolder | null>(null);
  const [cleaning, setCleaning] = useState(false);
  const [cleaningAll, setCleaningAll] = useState(false);
  const [result, setResult] = useState<CleanupResult | null>(null);
  const [allResults, setAllResults] = useState<CleanupResult[]>([]);
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);

  useEffect(() => {
    loadFolders();
  }, []);

  async function loadFolders() {
    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("cleanup-part-card", {
        body: { listOnly: true },
      });
      if (error) throw error;
      setFolders(data.folders || []);
    } catch (e) {
      toast.error("Nepodařilo se načíst složky: " + String(e));
    } finally {
      setLoading(false);
    }
  }

  async function cleanupCard(folder: PartFolder): Promise<CleanupResult | null> {
    try {
      const { data, error } = await supabase.functions.invoke("cleanup-part-card", {
        body: { folderId: folder.id, folderName: folder.name },
      });
      if (error) throw error;
      if (data.error) throw new Error(data.error);
      return data as CleanupResult;
    } catch (e) {
      toast.error(`Chyba u ${folder.name}: ${String(e)}`);
      return null;
    }
  }

  async function handleCleanupSingle() {
    if (!selectedFolder) return;
    setCleaning(true);
    setResult(null);
    const res = await cleanupCard(selectedFolder);
    if (res) {
      setResult(res);
      toast.success(`✅ ${res.cardName} vyčištěna`);
    }
    setCleaning(false);
  }

  async function handleCleanupAll() {
    if (folders.length === 0) return;
    setCleaningAll(true);
    setAllResults([]);
    setProgress({ current: 0, total: folders.length });

    const results: CleanupResult[] = [];
    for (let i = 0; i < folders.length; i++) {
      setProgress({ current: i + 1, total: folders.length });
      const res = await cleanupCard(folders[i]);
      if (res) results.push(res);
    }

    setAllResults(results);
    setCleaningAll(false);
    setProgress(null);
    toast.success(`✅ Vyčištěno ${results.length}/${folders.length} karet`);
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 mb-2">
        <Sparkles className="w-4 h-4 text-primary" />
        <h3 className="text-xs font-semibold text-foreground">Cleanup karet</h3>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="w-3 h-3 animate-spin" /> Načítám složky...
        </div>
      ) : (
        <>
          <div className="space-y-2">
            <select
              className="w-full text-xs p-2 rounded-md border border-border bg-background text-foreground"
              value={selectedFolder?.id || ""}
              onChange={(e) => {
                const f = folders.find((f) => f.id === e.target.value);
                setSelectedFolder(f || null);
                setResult(null);
              }}
            >
              <option value="">— Vyber složku části —</option>
              {folders.map((f) => (
                <option key={f.id} value={f.id}>{f.name}</option>
              ))}
            </select>

            <div className="flex gap-2">
              <Button
                size="sm"
                className="h-7 text-[10px] gap-1"
                disabled={!selectedFolder || cleaning || cleaningAll}
                onClick={handleCleanupSingle}
              >
                {cleaning ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                Vyčistit kartu
              </Button>

              <Button
                size="sm"
                variant="destructive"
                className="h-7 text-[10px] gap-1"
                disabled={folders.length === 0 || cleaning || cleaningAll}
                onClick={handleCleanupAll}
              >
                {cleaningAll ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
                Vyčistit VŠECHNY
              </Button>
            </div>
          </div>

          {progress && (
            <div className="text-[10px] text-muted-foreground">
              Zpracovávám {progress.current}/{progress.total}...
            </div>
          )}

          {result && <CleanupResultCard result={result} />}

          {allResults.length > 0 && (
            <div className="space-y-2 mt-3">
              <p className="text-[10px] font-medium text-foreground">Výsledky ({allResults.length} karet):</p>
              {allResults.map((r, i) => (
                <CleanupResultCard key={i} result={r} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function CleanupResultCard({ result }: { result: CleanupResult }) {
  const saved = result.originalSize - result.cleanedSize;
  const pct = result.originalSize > 0 ? Math.round((saved / result.originalSize) * 100) : 0;

  return (
    <div className="rounded-md border border-border p-2 text-[10px] space-y-1 bg-muted/30">
      <p className="font-medium text-foreground">{result.cardName}</p>
      <div className="flex flex-wrap gap-2 text-muted-foreground">
        <span>{result.originalSize.toLocaleString()} → {result.cleanedSize.toLocaleString()} znaků</span>
        {saved > 0 && <Badge variant="secondary" className="h-4 px-1 text-[8px]">-{pct}%</Badge>}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5">
        {result.log.duplicatesRemoved > 0 && <span>🗑 {result.log.duplicatesRemoved} duplicit</span>}
        {result.log.testsRemoved > 0 && <span>🧪 {result.log.testsRemoved} testů</span>}
        {result.log.redistributionsIntegrated > 0 && <span>🔄 {result.log.redistributionsIntegrated} redistribucí</span>}
        {result.log.movedToOtherCard > 0 && (
          <span>➡️ {result.log.movedToOtherCard} → {result.log.movedEntityNames.join(", ")}</span>
        )}
      </div>
    </div>
  );
}
