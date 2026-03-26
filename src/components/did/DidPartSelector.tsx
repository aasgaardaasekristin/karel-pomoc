import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sparkles, Loader2, Plus, FolderOpen, Moon, AlertTriangle } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import avatarKataSolo from "@/assets/avatar-kata-solo.png";

interface RegistryPart {
  id: string;
  part_name: string;
  display_name: string;
  status: string;
}

interface Props {
  therapistName: string;
  knownParts: string[];
  onSelectPart: (partName: string) => void;
  onBack: () => void;
  onOpenKartoteka?: () => void;
}

const DidPartSelector = ({ therapistName, knownParts, onSelectPart, onBack, onOpenKartoteka }: Props) => {
  const [registryParts, setRegistryParts] = useState<RegistryPart[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedPartName, setSelectedPartName] = useState("");
  const [newPartName, setNewPartName] = useState("");
  const [isCreating, setIsCreating] = useState(false);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      const { data } = await supabase
        .from("did_part_registry")
        .select("id, part_name, display_name, status")
        .order("display_name");
      // Sort: active first, then warning, then sleeping
      const sorted = ((data as RegistryPart[]) || []).sort((a, b) => {
        const order: Record<string, number> = { active: 0, warning: 1, sleeping: 2 };
        const diff = (order[a.status] ?? 2) - (order[b.status] ?? 2);
        if (diff !== 0) return diff;
        return a.display_name.localeCompare(b.display_name);
      });
      setRegistryParts(sorted);
      setLoading(false);
    };
    load();
  }, []);

  const handleStartSession = () => {
    if (!selectedPartName) return;
    onSelectPart(selectedPartName);
  };

  const handleCreateAndStart = async () => {
    const name = newPartName.trim();
    if (!name) return;
    setIsCreating(true);
    try {
      const existingPrefixes = new Set(
        registryParts
          .map(p => {
            const match = p.part_name.match(/^(\d{3})_/);
            return match ? parseInt(match[1], 10) : null;
          })
          .filter((n): n is number => n !== null)
      );
      let nextId = 1;
      while (existingPrefixes.has(nextId) && nextId < 1000) nextId++;
      const partName = `${String(nextId).padStart(3, "0")}_${name.replace(/\s+/g, "_")}`;

      const { data, error } = await supabase
        .from("did_part_registry")
        .insert({ part_name: partName, display_name: name, status: "active" })
        .select("id, part_name, display_name, status")
        .single();
      if (error) throw error;
      if (data) {
        setRegistryParts(prev => [...prev, data as RegistryPart].sort((a, b) => a.display_name.localeCompare(b.display_name)));
        toast.success(`Část „${name}" vytvořena (${partName})`);
        onSelectPart(partName);
      }
    } catch (e: any) {
      toast.error("Nepodařilo se vytvořit část: " + (e.message || ""));
    } finally {
      setIsCreating(false);
    }
  };

  const statusDot = (status: string) => {
    if (status === "active") return "bg-emerald-400";
    if (status === "warning") return "bg-amber-400";
    return "bg-muted-foreground/40";
  };

  return (
    <ScrollArea className="flex-1">
      <div className="max-w-md mx-auto px-5 py-10 sm:py-14 space-y-7">
        {/* Hero */}
        <div className="text-center space-y-2">
          <div className="w-11 h-11 rounded-xl bg-primary/8 flex items-center justify-center mx-auto">
            <Sparkles className="w-5 h-5 text-primary/70" />
          </div>
          <h2 className="text-lg font-serif font-medium text-foreground tracking-tight">
            Sezení s částí
          </h2>
          <p className="text-[0.8125rem] text-muted-foreground/80 max-w-xs mx-auto leading-relaxed">
            {therapistName}, vyber část z kartotéky nebo zadej jméno nové.
          </p>
        </div>

        {/* Selection card */}
        <div className="bg-card border border-border/60 rounded-xl p-5 space-y-4 shadow-[0_1px_3px_hsl(var(--foreground)/0.04)]">
          <h3 className="text-[0.8125rem] font-medium text-foreground/90">Vybrat část</h3>
          {loading ? (
            <div className="flex justify-center py-3">
              <Loader2 className="w-4 h-4 animate-spin text-muted-foreground/60" />
            </div>
          ) : (
            <Select value={selectedPartName} onValueChange={setSelectedPartName}>
              <SelectTrigger className="h-9 text-[0.8125rem]">
                <SelectValue placeholder="Vyberte část z kartotéky..." />
              </SelectTrigger>
              <SelectContent>
                {registryParts.map(p => (
                  <SelectItem key={p.id} value={p.part_name} className="text-[0.8125rem]">
                    <span className="flex items-center gap-2">
                      <span className={`w-1.5 h-1.5 rounded-full ${statusDot(p.status)} shrink-0`} />
                      <span className="text-muted-foreground/60 font-mono text-[0.6875rem]">{p.part_name.match(/^\d{3}/)?.[0] || ""}</span>
                      <span>{p.display_name || p.part_name}</span>
                      {p.status === "sleeping" && <Moon className="w-3 h-3 text-muted-foreground/40 ml-auto" />}
                      {p.status === "warning" && <AlertTriangle className="w-3 h-3 text-amber-400/70 ml-auto" />}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Button className="w-full h-9 gap-2 text-[0.8125rem]" onClick={handleStartSession} disabled={!selectedPartName}>
            <Plus className="w-3.5 h-3.5" /> Zahájit sezení
          </Button>

          <div className="relative my-1">
            <div className="absolute inset-0 flex items-center">
              <span className="w-full border-t border-border/40" />
            </div>
            <div className="relative flex justify-center text-[0.6875rem] uppercase tracking-wider">
              <span className="bg-card px-3 text-muted-foreground/60">nebo nová část</span>
            </div>
          </div>

          <div className="flex gap-2">
            <Input
              placeholder="Jméno nové části..."
              value={newPartName}
              onChange={e => setNewPartName(e.target.value)}
              className="h-9 text-[0.8125rem] flex-1"
              onKeyDown={e => { if (e.key === "Enter") handleCreateAndStart(); }}
            />
            <Button
              variant="outline"
              size="icon"
              className="h-9 w-9 shrink-0"
              onClick={handleCreateAndStart}
              disabled={!newPartName.trim() || isCreating}
            >
              {isCreating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UserPlus className="w-3.5 h-3.5" />}
            </Button>
          </div>
        </div>

        {/* Kartotéka shortcut */}
        {onOpenKartoteka && (
          <Button
            variant="outline"
            onClick={onOpenKartoteka}
            className="w-full h-9 gap-2 text-[0.8125rem] border-border/50 text-muted-foreground hover:text-foreground"
          >
            <FolderOpen className="w-3.5 h-3.5" />
            Otevřít kartotéku
          </Button>
        )}

        {/* Back */}
        <Button variant="ghost" size="sm" onClick={onBack} className="w-full text-[0.75rem] text-muted-foreground/70 hover:text-foreground">
          ← Zpět
        </Button>
      </div>
    </ScrollArea>
  );
};

export default DidPartSelector;
