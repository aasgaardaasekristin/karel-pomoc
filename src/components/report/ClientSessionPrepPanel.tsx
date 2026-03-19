import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Loader2, CalendarPlus, BookOpen, RefreshCw, Save, CheckCircle2 } from "lucide-react";
import { getAuthHeaders } from "@/lib/auth";
import { supabase } from "@/integrations/supabase/client";
import ReactMarkdown from "react-markdown";
import { toast } from "sonner";

interface ClientSessionPrepPanelProps {
  clientId: string;
  clientName: string;
}

type PrepStatus = "form" | "generating" | "ready";

const ClientSessionPrepPanel = ({ clientId, clientName }: ClientSessionPrepPanelProps) => {
  const [status, setStatus] = useState<PrepStatus>("form");
  const [duration, setDuration] = useState("60");
  const [additionalInfo, setAdditionalInfo] = useState("");
  const [focusArea, setFocusArea] = useState("");
  const [prepResult, setPrepResult] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Streaming state
  const [streamContent, setStreamContent] = useState("");

  const handleGenerate = async () => {
    setStatus("generating");
    setStreamContent("");
    setPrepResult("");

    try {
      const headers = await getAuthHeaders();
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-client-session-prep`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          clientId,
          clientName,
          duration: parseInt(duration) || 60,
          additionalInfo: additionalInfo.trim(),
          focusArea: focusArea.trim(),
        }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `Chyba ${res.status}`);
      }

      if (!res.body) throw new Error("No stream body");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let fullContent = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let newlineIdx: number;
        while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
          let line = buffer.slice(0, newlineIdx);
          buffer = buffer.slice(newlineIdx + 1);
          if (line.endsWith("\r")) line = line.slice(0, -1);
          if (!line.startsWith("data: ")) continue;
          const jsonStr = line.slice(6).trim();
          if (jsonStr === "[DONE]") break;
          try {
            const parsed = JSON.parse(jsonStr);
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) {
              fullContent += delta;
              setStreamContent(fullContent);
            }
          } catch { /* partial */ }
        }
      }

      setPrepResult(fullContent);
      setStatus("ready");
    } catch (e: any) {
      toast.error(e.message || "Nepodařilo se vygenerovat přípravu");
      setStatus("form");
    }
  };

  const handleSave = async () => {
    if (!prepResult) return;
    setIsSaving(true);
    try {
      const { error } = await supabase.from("client_sessions").insert({
        client_id: clientId,
        session_date: new Date().toISOString().split("T")[0],
        ai_recommended_methods: prepResult,
        notes: `Příprava na sezení (${duration} min)${focusArea ? ` – zaměření: ${focusArea}` : ""}`,
      });
      if (error) throw error;
      setSaved(true);
      toast.success("Příprava uložena do záznamu klienta");
    } catch (e: any) {
      toast.error("Nepodařilo se uložit přípravu");
    } finally {
      setIsSaving(false);
    }
  };

  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [streamContent]);

  // ─── FORM ───
  if (status === "form") {
    return (
      <ScrollArea className="flex-1">
        <div className="max-w-2xl mx-auto px-4 py-6 space-y-6">
          <div className="text-center space-y-2">
            <div className="w-14 h-14 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto">
              <CalendarPlus className="w-7 h-7 text-primary" />
            </div>
            <h3 className="text-lg font-serif font-semibold">Připravit sezení pro {clientName}</h3>
            <p className="text-sm text-muted-foreground">
              Karel prostuduje kartu klienta, historii sezení a vyhledá nejlepší strategie na míru.
            </p>
          </div>

          <div className="bg-card border border-border rounded-xl p-5 space-y-4">
            <div className="space-y-1.5">
              <Label className="text-sm">Délka sezení (minuty)</Label>
              <Input
                type="number"
                value={duration}
                onChange={(e) => setDuration(e.target.value)}
                min={15}
                max={120}
                className="h-10"
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-sm">Na co se chceš zaměřit? (volitelné)</Label>
              <Textarea
                value={focusArea}
                onChange={(e) => setFocusArea(e.target.value)}
                placeholder="Např. práce s agresí, separační úzkost, nácvik sociálních dovedností…"
                className="min-h-[60px] text-sm"
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-sm">Nové informace / změna okolností (volitelné)</Label>
              <Textarea
                value={additionalInfo}
                onChange={(e) => setAdditionalInfo(e.target.value)}
                placeholder="Např. rodiče se rozchází, změna školy, nový lék…"
                className="min-h-[60px] text-sm"
              />
            </div>

            <Button className="w-full h-12 gap-2 text-base" onClick={handleGenerate}>
              <BookOpen className="w-5 h-5" />
              Připravit sezení
            </Button>
          </div>
        </div>
      </ScrollArea>
    );
  }

  // ─── GENERATING / READY ───
  const content = status === "generating" ? streamContent : prepResult;

  return (
    <div className="flex flex-col h-[calc(100vh-200px)]">
      {/* Header */}
      <div className="px-4 py-3 border-b border-border flex items-center justify-between">
        <div className="flex items-center gap-2">
          {status === "generating" ? (
            <Loader2 className="w-4 h-4 animate-spin text-primary" />
          ) : (
            <CheckCircle2 className="w-4 h-4 text-primary" />
          )}
          <span className="text-sm font-medium">
            {status === "generating" ? "Karel připravuje sezení…" : `Příprava pro ${clientName}`}
          </span>
        </div>
        {status === "ready" && (
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 text-xs"
              onClick={() => { setStatus("form"); setPrepResult(""); setSaved(false); }}
            >
              <RefreshCw className="w-3 h-3" />
              Nová příprava
            </Button>
            <Button
              size="sm"
              className="h-8 gap-1.5 text-xs"
              onClick={handleSave}
              disabled={isSaving || saved}
            >
              {isSaving ? <Loader2 className="w-3 h-3 animate-spin" /> : saved ? <CheckCircle2 className="w-3 h-3" /> : <Save className="w-3 h-3" />}
              {saved ? "Uloženo" : "Uložit do karty"}
            </Button>
          </div>
        )}
      </div>

      {/* Content */}
      <ScrollArea className="flex-1 px-4 py-4">
        <div className="max-w-2xl mx-auto">
          <div className="prose prose-sm dark:prose-invert max-w-none [&>p]:my-1.5 [&>h2]:mt-4 [&>h2]:mb-2 [&>h3]:mt-3 [&>h3]:mb-1 [&>ul]:my-1 [&>ol]:my-1">
            <ReactMarkdown>{content || "Načítání…"}</ReactMarkdown>
          </div>
          <div ref={scrollRef} />
        </div>
      </ScrollArea>
    </div>
  );
};

export default ClientSessionPrepPanel;
