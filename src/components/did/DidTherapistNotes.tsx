import { useState, useEffect } from "react";
import { Loader2, Trash2, StickyNote, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

interface TherapistNote {
  id: string;
  author: string;
  part_name: string | null;
  note_type: string;
  note_text: string;
  priority: string;
  tags: string[];
  is_read_by_karel: boolean;
  session_date: string;
  created_at: string;
}

const NOTE_TYPE_ICONS: Record<string, string> = {
  observation: "👁️",
  instruction: "📋",
  warning: "⚠️",
  progress: "📈",
  offline_session: "🏠",
  medication: "💊",
  context: "🌍",
};

const NOTE_TYPE_LABELS: Record<string, string> = {
  observation: "Pozorování",
  instruction: "Instrukce",
  warning: "Varování",
  progress: "Pokrok",
  offline_session: "Offline sezení",
  medication: "Medikace",
  context: "Kontext",
};

const PRIORITY_COLORS: Record<string, string> = {
  urgent: "border-l-destructive",
  high: "border-l-amber-500",
  normal: "border-l-primary",
  low: "border-l-muted-foreground/30",
};

const DidTherapistNotes = () => {
  const [notes, setNotes] = useState<TherapistNote[]>([]);
  const [parts, setParts] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Form state
  const [author, setAuthor] = useState("hanka");
  const [partName, setPartName] = useState<string>("__general__");
  const [noteType, setNoteType] = useState("observation");
  const [priority, setPriority] = useState("normal");
  const [noteText, setNoteText] = useState("");
  const [tags, setTags] = useState("");
  const [sessionDate, setSessionDate] = useState(new Date().toISOString().slice(0, 10));

  // Filters
  const [filterPart, setFilterPart] = useState("__all__");
  const [filterType, setFilterType] = useState("__all__");

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    setLoading(true);
    const [notesRes, partsRes] = await Promise.all([
      supabase.from("therapist_notes").select("*").order("created_at", { ascending: false }).limit(50),
      supabase.from("did_part_registry").select("part_name").eq("status", "active"),
    ]);
    setNotes((notesRes.data || []) as TherapistNote[]);
    setParts((partsRes.data || []).map((p: any) => p.part_name));
    setLoading(false);
  }

  async function handleSave() {
    if (!noteText.trim()) { toast.error("Poznámka nesmí být prázdná"); return; }
    setSaving(true);
    const { error } = await supabase.from("therapist_notes").insert({
      author,
      part_name: partName === "__general__" ? null : partName,
      note_type: noteType,
      note_text: noteText.trim(),
      priority,
      tags: tags.split(",").map(t => t.trim()).filter(Boolean),
      session_date: sessionDate,
    });
    if (error) { toast.error("Chyba při ukládání"); console.error(error); }
    else {
      toast.success("Poznámka uložena");
      setNoteText("");
      setTags("");
      loadData();
    }
    setSaving(false);
  }

  async function handleDelete(id: string) {
    await supabase.from("therapist_notes").delete().eq("id", id);
    setNotes(prev => prev.filter(n => n.id !== id));
    toast.success("Smazáno");
  }

  const filtered = notes.filter(n => {
    if (filterPart !== "__all__" && (filterPart === "__general__" ? n.part_name !== null : n.part_name !== filterPart)) return false;
    if (filterType !== "__all__" && n.note_type !== filterType) return false;
    return true;
  });

  if (loading) return <div className="flex justify-center py-6"><Loader2 className="w-5 h-5 animate-spin text-primary" /></div>;

  return (
    <div className="space-y-4">
      {/* ── FORMULÁŘ ── */}
      <div className="rounded-lg border bg-card p-3 space-y-2">
        <p className="text-xs font-semibold flex items-center gap-1.5"><Plus className="w-3.5 h-3.5" /> Nová poznámka</p>
        <div className="grid grid-cols-2 gap-2">
          <Select value={author} onValueChange={setAuthor}>
            <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="hanka">Hanka</SelectItem>
              <SelectItem value="kata">Káťa</SelectItem>
            </SelectContent>
          </Select>
          <Select value={partName} onValueChange={setPartName}>
            <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__general__">Obecné (celý systém)</SelectItem>
              {parts.map(p => <SelectItem key={p} value={p}>{p}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={noteType} onValueChange={setNoteType}>
            <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              {Object.entries(NOTE_TYPE_LABELS).map(([k, v]) => (
                <SelectItem key={k} value={k}>{NOTE_TYPE_ICONS[k]} {v}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={priority} onValueChange={setPriority}>
            <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="low">Nízká</SelectItem>
              <SelectItem value="normal">Normální</SelectItem>
              <SelectItem value="high">Vysoká</SelectItem>
              <SelectItem value="urgent">Urgentní</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Input type="date" value={sessionDate} onChange={e => setSessionDate(e.target.value)} className="h-8 text-xs" />
        <Textarea value={noteText} onChange={e => setNoteText(e.target.value)} placeholder="Text poznámky..." className="min-h-[60px] text-xs" />
        <Input value={tags} onChange={e => setTags(e.target.value)} placeholder="Tagy (čárkou oddělené)" className="h-8 text-xs" />
        <Button size="sm" className="h-7 text-xs w-full gap-1.5" onClick={handleSave} disabled={saving}>
          {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <StickyNote className="w-3 h-3" />}
          💾 Uložit poznámku
        </Button>
      </div>

      {/* ── FILTRY ── */}
      <div className="flex gap-2">
        <Select value={filterPart} onValueChange={setFilterPart}>
          <SelectTrigger className="h-7 text-xs flex-1"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">Všechny části</SelectItem>
            <SelectItem value="__general__">Obecné</SelectItem>
            {parts.map(p => <SelectItem key={p} value={p}>{p}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={filterType} onValueChange={setFilterType}>
          <SelectTrigger className="h-7 text-xs flex-1"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">Všechny typy</SelectItem>
            {Object.entries(NOTE_TYPE_LABELS).map(([k, v]) => (
              <SelectItem key={k} value={k}>{v}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* ── SEZNAM ── */}
      <div className="space-y-2">
        {filtered.length === 0 && (
          <p className="text-xs text-muted-foreground text-center py-4">Žádné poznámky</p>
        )}
        {filtered.map(note => (
          <div key={note.id} className={cn(
            "rounded-lg border border-l-4 p-3 text-sm space-y-1",
            PRIORITY_COLORS[note.priority] || "border-l-muted-foreground/30",
          )}>
            <div className="flex justify-between items-start">
              <div className="flex items-center gap-1.5 text-xs">
                <span>{NOTE_TYPE_ICONS[note.note_type] || "📝"}</span>
                <span className="font-medium text-foreground">{note.part_name || "Obecné"}</span>
                <span className="text-muted-foreground">— {note.author}</span>
                <span className="text-muted-foreground">{new Date(note.session_date).toLocaleDateString("cs")}</span>
              </div>
              <div className="flex items-center gap-1">
                {note.is_read_by_karel && <Badge variant="outline" className="text-[9px] h-4 text-emerald-600">✅ Karel přečetl</Badge>}
                <Button variant="ghost" size="sm" className="h-5 w-5 p-0" onClick={() => handleDelete(note.id)}>
                  <Trash2 className="w-3 h-3 text-muted-foreground" />
                </Button>
              </div>
            </div>
            <p className="text-xs text-foreground whitespace-pre-wrap">{note.note_text}</p>
            {note.tags?.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {note.tags.map((t, i) => <Badge key={i} variant="secondary" className="text-[9px] h-4">{t}</Badge>)}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

export default DidTherapistNotes;
