import { useEffect, useState } from "react";
import { Clock3, Loader2, MessageCircleMore, Pin, Trash2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";

export type SavedTopicSummary = {
  id: string;
  title: string;
  extracted_context: string;
  created_at: string;
  last_continued_at: string | null;
};

interface Props {
  onContinueTopic: (topic: SavedTopicSummary) => Promise<void>;
}

const formatDate = (value: string | null) => {
  if (!value) return "zatím nepokračováno";
  return new Date(value).toLocaleDateString("cs-CZ", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
};

const HanaSavedTopics = ({ onContinueTopic }: Props) => {
  const [topics, setTopics] = useState<SavedTopicSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [continuingId, setContinuingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SavedTopicSummary | null>(null);

  useEffect(() => {
    const fetchTopics = async () => {
      setLoading(true);
      const { data, error } = await supabase
        .from("karel_saved_topics")
        .select("id, title, extracted_context, created_at, last_continued_at")
        .eq("section", "hana")
        .eq("sub_mode", "personal")
        .eq("is_active", true)
        .order("last_continued_at", { ascending: false, nullsFirst: false })
        .order("created_at", { ascending: false });

      if (error) {
        console.error("[HanaSavedTopics] Fetch error:", error);
        toast.error("Nepodařilo se načíst rozpracovaná témata");
      } else {
        setTopics((data ?? []) as SavedTopicSummary[]);
      }
      setLoading(false);
    };

    void fetchTopics();

    const channel = supabase
      .channel("hana_saved_topics")
      .on("postgres_changes", { event: "*", schema: "public", table: "karel_saved_topics" }, () => {
        void fetchTopics();
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const handleDelete = async () => {
    if (!deleteTarget) return;
    const { error } = await supabase
      .from("karel_saved_topics")
      .update({ is_active: false, pending_drive_sync: false })
      .eq("id", deleteTarget.id);

    if (error) {
      toast.error("Nepodařilo se smazat téma");
      return;
    }

    setTopics((prev) => prev.filter((topic) => topic.id !== deleteTarget.id));
    toast.success(`Téma „${deleteTarget.title}“ bylo odstraněno`);
    setDeleteTarget(null);
  };

  const handleContinue = async (topic: SavedTopicSummary) => {
    setContinuingId(topic.id);
    try {
      await onContinueTopic(topic);
    } finally {
      setContinuingId(null);
    }
  };

  return (
    <div className="rounded-2xl border border-border bg-card/70 px-4 py-4 shadow-sm space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Pin className="w-4 h-4 text-primary" />
          <h3 className="text-sm font-medium text-foreground">Rozpracovaná témata</h3>
        </div>
        <span className="text-xs text-muted-foreground">{topics.length}</span>
      </div>

      {loading ? (
        <div className="rounded-xl border border-dashed border-border bg-muted/30 px-4 py-5 text-sm text-muted-foreground text-center">
          Načítám témata…
        </div>
      ) : topics.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-muted/30 px-4 py-5 text-sm text-muted-foreground text-center">
          Zatím nemáš žádná uložená témata.
        </div>
      ) : (
        <div className="space-y-2">
          {topics.map((topic) => (
            <div key={topic.id} className="rounded-xl border border-border bg-background/60 px-3 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <div className="text-sm font-medium text-foreground truncate">{topic.title}</div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.6875rem] text-muted-foreground">
                    <span>Vytvořeno {formatDate(topic.created_at)}</span>
                    <span className="inline-flex items-center gap-1">
                      <Clock3 className="w-3 h-3" />
                      {formatDate(topic.last_continued_at)}
                    </span>
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 rounded-xl shrink-0"
                  onClick={() => setDeleteTarget(topic)}
                >
                  <Trash2 className="text-destructive" />
                </Button>
              </div>

              <div className="mt-3 flex justify-start">
                <Button
                  variant="outline"
                  size="sm"
                  className="rounded-xl gap-1.5"
                  disabled={continuingId === topic.id}
                  onClick={() => void handleContinue(topic)}
                >
                  {continuingId === topic.id ? <Loader2 className="animate-spin" /> : <MessageCircleMore />}
                  Pokračovat v hovoru
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent className="rounded-2xl">
          <AlertDialogHeader>
            <AlertDialogTitle>Smazat téma?</AlertDialogTitle>
            <AlertDialogDescription>
              Opravdu smazat téma „{deleteTarget?.title}“? Původní vlákna zůstanou beze změny.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="rounded-xl">Zrušit</AlertDialogCancel>
            <AlertDialogAction className="rounded-xl bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={handleDelete}>
              Smazat téma
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default HanaSavedTopics;