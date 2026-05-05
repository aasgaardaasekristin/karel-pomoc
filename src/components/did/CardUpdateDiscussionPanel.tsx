// P28_CDI_2d — UI for card update discussion (card_update_queue)
// Loads pending_therapist_confirmation rows, lets Hanka/Káťa add a safe
// discussion comment that flows through the server endpoint
// (submitCardUpdateDiscussion). Shows safe_summary only — never raw content.
import { useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw, MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import {
  submitCardUpdateDiscussion,
  refetchCardUpdateRow,
  type CardUpdateDiscussionMode,
} from "@/services/cardUpdateDiscussion";

type Author = "hanka" | "kata";

interface QueueRow {
  id: string;
  part_id: string;
  section: string;
  action: string;
  status: string;
  applied: boolean;
  reason: string | null;
  created_at: string;
  payload: any;
}

const MAX_LEN = 2000;

export default function CardUpdateDiscussionPanel() {
  const [rows, setRows] = useState<QueueRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [author, setAuthor] = useState<Author>("hanka");
  const [mode, setMode] = useState<CardUpdateDiscussionMode>("discussion_comment");
  const [submitting, setSubmitting] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("card_update_queue")
        .select("id, part_id, section, action, status, applied, reason, created_at, payload")
        .eq("status", "pending_therapist_confirmation")
        .order("created_at", { ascending: false })
        .limit(15);
      if (error) throw error;
      setRows((data as any[]) ?? []);
    } catch (e) {
      toast.error(`Nelze načíst návrhy karet: ${(e as Error).message}`);
    }
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  const trimmed = draft.trim();
  const tooLong = draft.length > MAX_LEN;
  const canSubmit = openId && !submitting && trimmed.length > 0 && !tooLong;

  async function handleSubmit(cardUpdateId: string) {
    if (!canSubmit) return;
    setSubmitting(true);
    // Idempotency: stable per card+author+mode+message snapshot.
    const idempotencyKey = `cu-disc-${cardUpdateId}-${author}-${mode}-${Date.now()}`;
    try {
      const res = await submitCardUpdateDiscussion({
        cardUpdateId,
        message: trimmed,
        author,
        mode,
        idempotencyKey,
      });
      if (!res.ok) {
        toast.error(`Komentář se nepodařilo uložit: ${res.error ?? "unknown"}`);
        return;
      }
      if (res.deduplicated) {
        toast.info("Duplicitní odeslání — komentář už existuje.");
      } else {
        toast.success("Komentář uložen do diskuse.");
      }
      // Refetch the single row for instant UI update + invalidate list.
      const { data: refreshed } = await refetchCardUpdateRow(cardUpdateId);
      setRows((prev) =>
        prev.map((r) => (r.id === cardUpdateId && refreshed ? { ...r, payload: refreshed.payload, status: refreshed.status, applied: refreshed.applied } : r)),
      );
      setDraft("");
    } catch (e) {
      toast.error(`Chyba: ${(e as Error).message}`);
    }
    setSubmitting(false);
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-medium flex items-center gap-1.5">
          <MessageSquare className="w-3.5 h-3.5" /> Diskuse k návrhům změn karet
        </h4>
        <Button size="sm" variant="ghost" className="h-6 text-[10px]" onClick={load} disabled={loading}>
          {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
        </Button>
      </div>

      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground text-center py-3">
          {loading ? "Načítání..." : "Žádné návrhy čekající na potvrzení."}
        </p>
      ) : (
        <div className="space-y-2 max-h-96 overflow-y-auto">
          {rows.map((r) => {
            const discussion: any[] = Array.isArray(r.payload?.discussion) ? r.payload.discussion : [];
            const open = openId === r.id;
            return (
              <div key={r.id} className="rounded-md border bg-muted/20 p-2 text-[11px]">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="font-medium truncate">{r.part_id}</span>
                    <span className="text-muted-foreground truncate">· {r.section}</span>
                    <Badge variant="secondary" className="h-4 text-[8px] px-1">{r.action}</Badge>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 text-[10px]"
                    onClick={() => { setOpenId(open ? null : r.id); setDraft(""); }}
                  >
                    {open ? "Zavřít" : `Diskuse (${discussion.length})`}
                  </Button>
                </div>

                {open && (
                  <div className="mt-2 space-y-2">
                    {discussion.length > 0 && (
                      <div className="space-y-1 max-h-32 overflow-y-auto">
                        {discussion.map((d, i) => (
                          <div key={i} className="rounded border-border/50 border bg-background/40 p-1.5 text-[10px]">
                            <div className="flex items-center justify-between text-muted-foreground">
                              <span>{d.author} · {d.mode}</span>
                              <span>{d.at ? new Date(d.at).toLocaleTimeString("cs", { hour: "2-digit", minute: "2-digit" }) : ""}</span>
                            </div>
                            {/* Safety: render only safe_summary, never raw text */}
                            <div>{d.safe_summary ?? "[komentář]"}</div>
                          </div>
                        ))}
                      </div>
                    )}

                    <div className="flex gap-1.5">
                      <select
                        value={author}
                        onChange={(e) => setAuthor(e.target.value as Author)}
                        className="h-7 text-[10px] rounded border bg-background px-1"
                      >
                        <option value="hanka">Hanka</option>
                        <option value="kata">Káťa</option>
                      </select>
                      <select
                        value={mode}
                        onChange={(e) => setMode(e.target.value as CardUpdateDiscussionMode)}
                        className="h-7 text-[10px] rounded border bg-background px-1 flex-1"
                      >
                        <option value="discussion_comment">Komentář k diskusi</option>
                        <option value="decision_note">Rozhodnutí</option>
                        <option value="request_change">Požadavek na změnu</option>
                      </select>
                    </div>

                    <Textarea
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      placeholder="Bezpečný komentář k návrhu změny karty (bez klinického obsahu)…"
                      className="text-[11px] min-h-[60px]"
                      maxLength={MAX_LEN + 200}
                      disabled={submitting}
                    />
                    <div className="flex items-center justify-between">
                      <span className={`text-[9px] ${tooLong ? "text-destructive" : "text-muted-foreground"}`}>
                        {draft.length}/{MAX_LEN}
                      </span>
                      <Button
                        size="sm"
                        className="h-7 text-[10px]"
                        onClick={() => handleSubmit(r.id)}
                        disabled={!canSubmit}
                      >
                        {submitting ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : null}
                        Odeslat
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
