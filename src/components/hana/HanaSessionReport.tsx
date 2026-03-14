import { useState, useCallback } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { ClipboardList, Loader2, Save, Sparkles } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { getAuthHeaders } from "@/lib/auth";
import { toast } from "sonner";

type Message = { role: "user" | "assistant"; content: string };

interface HanaSessionReportProps {
  messages: Message[];
  disabled?: boolean;
}

interface SessionFields {
  clientName: string;
  keyTheme: string;
  summary: string;
  risks: string;
  nextGoal: string;
}

const EMPTY: SessionFields = { clientName: "", keyTheme: "", summary: "", risks: "", nextGoal: "" };

const HanaSessionReport = ({ messages, disabled }: HanaSessionReportProps) => {
  const [open, setOpen] = useState(false);
  const [fields, setFields] = useState<SessionFields>({ ...EMPTY });
  const [isPrefilling, setIsPrefilling] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const set = (k: keyof SessionFields, v: string) => setFields(prev => ({ ...prev, [k]: v }));

  const handlePrefill = useCallback(async () => {
    if (messages.length < 3) {
      toast.info("Potřebuji víc konverzace pro předvyplnění.");
      return;
    }
    setIsPrefilling(true);
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-prefill`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          messages: messages.slice(-40),
          hint: "Vrať JSON s poli: keyTheme (klíčové téma sezení), summary (stručné shrnutí 2-3 věty), risks (rizika nebo důležité poznámky), nextGoal (cíl dalšího sezení). Bez jmen klientů.",
        }),
      });
      if (!res.ok) throw new Error("Prefill error");
      const data = await res.json();
      setFields(prev => ({
        ...prev,
        keyTheme: data.keyTheme || prev.keyTheme,
        summary: data.context || data.summary || prev.summary,
        risks: Array.isArray(data.risks) ? data.risks.join(", ") : (data.risks || data.missingData || prev.risks),
        nextGoal: data.nextSessionGoal || data.nextGoal || prev.nextGoal,
      }));
      toast.success("Předvyplněno z chatu");
    } catch {
      toast.error("Chyba při předvyplňování");
    } finally {
      setIsPrefilling(false);
    }
  }, [messages]);

  const handleSave = useCallback(async () => {
    if (!fields.clientName.trim()) {
      toast.error("Zadej jméno klienta");
      return;
    }
    setIsSaving(true);
    try {
      // Find or create client
      const { data: existing } = await supabase
        .from("clients")
        .select("id")
        .ilike("name", fields.clientName.trim())
        .limit(1)
        .maybeSingle();

      let clientId: string;
      if (existing) {
        clientId = existing.id;
      } else {
        const { data: newClient, error } = await supabase
          .from("clients")
          .insert({ name: fields.clientName.trim() })
          .select("id")
          .single();
        if (error || !newClient) throw error || new Error("Failed to create client");
        clientId = newClient.id;
      }

      // Save session
      const { error: sessErr } = await supabase.from("client_sessions").insert({
        client_id: clientId,
        report_key_theme: fields.keyTheme || null,
        report_context: fields.summary || null,
        report_risks: fields.risks ? [fields.risks] : null,
        report_next_session_goal: fields.nextGoal || null,
        notes: `Rychlý zápis z režimu Hana – ${new Date().toLocaleDateString("cs-CZ")}`,
      });
      if (sessErr) throw sessErr;

      toast.success("Sezení uloženo");
      setFields({ ...EMPTY });
      setOpen(false);
    } catch (error) {
      console.error("Save session error:", error);
      toast.error("Chyba při ukládání");
    } finally {
      setIsSaving(false);
    }
  }, [fields]);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          className="h-7 px-2 text-xs gap-1"
        >
          <ClipboardList className="w-3 h-3" />
          <span className="hidden sm:inline">Zápis sezení</span>
          <span className="sm:hidden">📋</span>
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="w-[340px] sm:w-[400px]">
        <SheetHeader>
          <SheetTitle className="text-base">Rychlý zápis sezení</SheetTitle>
        </SheetHeader>
        <div className="mt-4 space-y-4">
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Klient</Label>
            <Input
              value={fields.clientName}
              onChange={e => set("clientName", e.target.value)}
              placeholder="Jméno / kód klienta"
              className="h-8 text-sm"
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Hlavní téma</Label>
            <Input
              value={fields.keyTheme}
              onChange={e => set("keyTheme", e.target.value)}
              placeholder="např. Úzkost, Vztahy, Trauma..."
              className="h-8 text-sm"
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Shrnutí sezení</Label>
            <Textarea
              value={fields.summary}
              onChange={e => set("summary", e.target.value)}
              placeholder="Stručný popis průběhu..."
              className="min-h-[80px] text-sm resize-none"
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Rizika / poznámky</Label>
            <Textarea
              value={fields.risks}
              onChange={e => set("risks", e.target.value)}
              placeholder="Rizikové faktory, důležité postřehy..."
              className="min-h-[60px] text-sm resize-none"
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Cíl dalšího sezení</Label>
            <Textarea
              value={fields.nextGoal}
              onChange={e => set("nextGoal", e.target.value)}
              placeholder="Na co navázat příště..."
              className="min-h-[60px] text-sm resize-none"
            />
          </div>

          <div className="flex gap-2 pt-2 border-t border-border">
            <Button
              variant="outline"
              size="sm"
              onClick={handlePrefill}
              disabled={isPrefilling || messages.length < 3}
              className="text-xs h-8 gap-1 flex-1"
            >
              {isPrefilling ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
              Předvyplnit z chatu
            </Button>
            <Button
              size="sm"
              onClick={handleSave}
              disabled={isSaving || !fields.clientName.trim()}
              className="text-xs h-8 gap-1 flex-1"
            >
              {isSaving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
              Uložit
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
};

export default HanaSessionReport;
