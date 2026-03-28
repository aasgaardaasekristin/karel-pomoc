import { useState } from "react";
import { StickyNote, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

interface Props {
  partName?: string | null;
  subMode?: string | null;
}

const QuickNoteDialog = ({ partName, subMode }: Props) => {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);

  const author = subMode === "kata" ? "kata" : "hanka";

  async function handleSave() {
    if (!text.trim()) return;
    setSaving(true);
    const { error } = await supabase.from("therapist_notes").insert({
      author,
      part_name: partName || null,
      note_type: "observation",
      note_text: text.trim(),
      priority: "normal",
    });
    if (error) toast.error("Chyba při ukládání");
    else {
      toast.success("Poznámka uložena");
      setText("");
      setOpen(false);
    }
    setSaving(false);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="h-7 w-7 p-0" title="Rychlá poznámka">
          <StickyNote className="w-3.5 h-3.5" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-sm flex items-center gap-2">
            <StickyNote className="w-4 h-4 text-primary" />
            Rychlá poznámka{partName ? ` — ${partName}` : ""}
          </DialogTitle>
        </DialogHeader>
        <Textarea
          value={text}
          onChange={e => setText(e.target.value)}
          placeholder="Co jste pozorovali offline..."
          className="min-h-[80px] text-sm"
          autoFocus
        />
        <Button size="sm" onClick={handleSave} disabled={saving || !text.trim()} className="gap-1.5">
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
          💾 Uložit
        </Button>
      </DialogContent>
    </Dialog>
  );
};

export default QuickNoteDialog;
