import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sparkles, UserPlus, Loader2, Plus, FolderOpen, CheckCircle, Moon, AlertTriangle } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

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

const STATUS_INDICATOR: Record<string, string> = {
  active: "🟢",
  sleeping: "🌙",
  warning: "⚠️",
};

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
      setRegistryParts((data as RegistryPart[]) || []);
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
      // Find smallest unused 3-digit prefix
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

  return (
    <ScrollArea className="flex-1">
      <div className="max-w-xl mx-auto px-4 py-8 sm:py-12 space-y-8">
        {/* Hero */}
        <div className="text-center space-y-3">
          <div className="w-14 h-14 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto">
            <Sparkles className="w-7 h-7 text-primary" />
          </div>
          <h2 className="text-xl sm:text-2xl font-serif font-semibold text-foreground">
            Sezení s částí
          </h2>
          <p className="text-sm text-muted-foreground max-w-sm mx-auto">
            {therapistName}, vyber část z kartotéky nebo zadej jméno nové části pro zahájení sezení.
          </p>
        </div>

        {/* Selection card */}
        <div className="bg-card border border-border rounded-xl p-5 sm:p-6 space-y-4 shadow-sm">
          <h3 className="text-sm font-medium text-foreground">Vybrat část</h3>
          {loading ? (
            <div className="flex justify-center py-4">
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <Select value={selectedPartName} onValueChange={setSelectedPartName}>
              <SelectTrigger className="h-10 text-sm">
                <SelectValue placeholder="Vyberte část z kartotéky..." />
              </SelectTrigger>
              <SelectContent>
                {registryParts.map(p => (
                  <SelectItem key={p.id} value={p.part_name}>
                    {STATUS_INDICATOR[p.status] || "🌙"} {p.display_name || p.part_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Button className="w-full h-10 gap-2" onClick={handleStartSession} disabled={!selectedPartName}>
            <Plus className="w-4 h-4" /> Zahájit sezení
          </Button>

          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <span className="w-full border-t border-border" />
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-card px-3 text-muted-foreground">nebo nová část</span>
            </div>
          </div>

          <div className="flex gap-2">
            <Input
              placeholder="Jméno nové části..."
              value={newPartName}
              onChange={e => setNewPartName(e.target.value)}
              className="h-10 text-sm flex-1"
              onKeyDown={e => { if (e.key === "Enter") handleCreateAndStart(); }}
            />
            <Button
              variant="outline"
              size="icon"
              className="h-10 w-10 shrink-0"
              onClick={handleCreateAndStart}
              disabled={!newPartName.trim() || isCreating}
            >
              {isCreating ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserPlus className="w-4 h-4" />}
            </Button>
          </div>
        </div>

        {/* Kartotéka shortcut */}
        {onOpenKartoteka && (
          <Button
            variant="outline"
            onClick={onOpenKartoteka}
            className="w-full h-10 gap-2 text-sm"
          >
            <FolderOpen className="w-4 h-4" />
            Otevřít kartotéku
          </Button>
        )}

        {/* Back */}
        <Button variant="ghost" size="sm" onClick={onBack} className="w-full">
          ← Zpět
        </Button>
      </div>
    </ScrollArea>
  );
};

export default DidPartSelector;
