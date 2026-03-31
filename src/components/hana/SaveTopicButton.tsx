import { useMemo, useState } from "react";
import { Loader2, Pin, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";

interface Props {
  disabled?: boolean;
  isSaving?: boolean;
  onSave: (title: string | null) => Promise<void>;
}

const SaveTopicButton = ({ disabled, isSaving = false, onSave }: Props) => {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const trimmedTitle = useMemo(() => title.trim(), [title]);

  const handleSave = async () => {
    await onSave(trimmedTitle || null);
    setTitle("");
    setOpen(false);
  };

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        disabled={disabled || isSaving}
        onClick={() => setOpen(true)}
        className="h-8 rounded-xl gap-1.5"
      >
        {isSaving ? <Loader2 className="animate-spin" /> : <Pin />}
        <span className="hidden sm:inline">Zachovej téma</span>
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="rounded-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Pin className="text-primary" />
              Zachovat téma
            </DialogTitle>
            <DialogDescription>
              Pojmenuj téma, které chceš zachovat, nebo nech pole prázdné a Karel ho pojmenuje automaticky.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">
              Pojmenuj téma které chceš zachovat
            </label>
            <Textarea
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="např. kde jsme mluvili o červené karkulce"
              className="min-h-[96px] rounded-xl"
              disabled={isSaving}
            />
          </div>

          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setOpen(false)} className="rounded-xl" disabled={isSaving}>
              Zrušit
            </Button>
            <Button onClick={handleSave} className="rounded-xl gap-1.5" disabled={isSaving}>
              {isSaving ? <Loader2 className="animate-spin" /> : <Sparkles />}
              Uložit téma
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};

export default SaveTopicButton;