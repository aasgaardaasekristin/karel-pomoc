import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { getAuthHeaders } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Loader2, ClipboardList, Search } from "lucide-react";
import { toast } from "sonner";
import RichMarkdown from "@/components/ui/RichMarkdown";

const DidSessionPrep = () => {
  const [open, setOpen] = useState(false);
  const [partNames, setPartNames] = useState<string[]>([]);
  const [selectedPart, setSelectedPart] = useState("");
  const [filter, setFilter] = useState("");
  const [briefing, setBriefing] = useState("");
  const [loading, setLoading] = useState(false);

  // Load unique part names from did_threads
  useEffect(() => {
    if (!open) return;
    (async () => {
      const { data } = await supabase
        .from("did_threads")
        .select("part_name")
        .eq("sub_mode", "cast")
        .order("last_activity_at", { ascending: false });
      if (data) {
        const unique = [...new Set(data.map(d => d.part_name))];
        setPartNames(unique);
      }
    })();
  }, [open]);

  const handlePrepare = useCallback(async (partName: string) => {
    setSelectedPart(partName);
    setLoading(true);
    setBriefing("");

    try {
      const headers = await getAuthHeaders();
      const resp = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-did-session-prep`,
        { method: "POST", headers, body: JSON.stringify({ partName }) }
      );

      if (!resp.ok) {
        if (resp.status === 429) { toast.error("Příliš mnoho požadavků, zkus to za chvíli."); setLoading(false); return; }
        if (resp.status === 402) { toast.error("Nedostatek kreditů."); setLoading(false); return; }
        toast.error("Chyba při přípravě briefingu.");
        setLoading(false);
        return;
      }

      if (!resp.body) { setLoading(false); return; }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let accumulated = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let idx: number;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          let line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          if (line.endsWith("\r")) line = line.slice(0, -1);
          if (line.startsWith(":") || line.trim() === "") continue;
          if (!line.startsWith("data: ")) continue;
          const jsonStr = line.slice(6).trim();
          if (jsonStr === "[DONE]") break;
          try {
            const parsed = JSON.parse(jsonStr);
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) {
              accumulated += content;
              setBriefing(accumulated);
            }
          } catch { /* partial */ }
        }
      }
    } catch (e: any) {
      toast.error(e.message || "Chyba při přípravě.");
    } finally {
      setLoading(false);
    }
  }, []);

  const filteredParts = partNames.filter(p =>
    !filter || p.toLowerCase().includes(filter.toLowerCase())
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="h-7 text-[10px] px-2 gap-1">
          <ClipboardList className="w-3 h-3" />
          Příprava na sezení
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-sm flex items-center gap-2">
            <ClipboardList className="w-4 h-4 text-primary" />
            Příprava na sezení
          </DialogTitle>
        </DialogHeader>

        {!selectedPart && !loading && (
          <div className="space-y-3">
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-2 text-muted-foreground" />
              <Input
                value={filter}
                onChange={e => setFilter(e.target.value)}
                placeholder="Vyhledat část..."
                className="pl-8 h-8 text-xs"
              />
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5 max-h-60 overflow-y-auto">
              {filteredParts.map(name => (
                <Button
                  key={name}
                  variant="outline"
                  size="sm"
                  onClick={() => handlePrepare(name)}
                  className="h-8 text-[0.6875rem] justify-start truncate"
                >
                  {name}
                </Button>
              ))}
              {filteredParts.length === 0 && (
                <p className="col-span-full text-xs text-muted-foreground text-center py-4">
                  {partNames.length === 0 ? "Žádné části v databázi." : "Nic nenalezeno."}
                </p>
              )}
            </div>
          </div>
        )}

        {(selectedPart || loading) && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium text-foreground">{selectedPart}</p>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => { setSelectedPart(""); setBriefing(""); setFilter(""); }}
                className="h-6 text-[0.625rem]"
              >
                ← Jiná část
              </Button>
            </div>

            {loading && !briefing && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground py-4">
                <Loader2 className="w-4 h-4 animate-spin" />
                Karel připravuje briefing...
              </div>
            )}

            {briefing && (
              <div className="text-[0.6875rem] leading-relaxed">
                <RichMarkdown compact>{briefing}</RichMarkdown>
                {loading && <Loader2 className="w-3 h-3 animate-spin text-primary inline-block ml-1" />}
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};

export default DidSessionPrep;
