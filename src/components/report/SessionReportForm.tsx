import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Loader2, Sparkles, FileDown, Lightbulb, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { getAuthHeaders } from "@/lib/auth";
import { useActiveSessions } from "@/contexts/ActiveSessionsContext";
import { useChatContext } from "@/contexts/ChatContext";
import TriageOutput from "@/components/TriageOutput";
import ReportOutput from "@/components/ReportOutput";
import { ReportFormData, TriageData } from "@/components/ReportForm";
import { useState } from "react";

const EMOTIONS = [
  { id: "calm", label: "Klid" },
  { id: "sadness", label: "Smutek" },
  { id: "helplessness", label: "Bezmoc" },
  { id: "anger", label: "Vztek" },
  { id: "fear", label: "Strach" },
  { id: "uncertainty", label: "Nejistota" },
];

const RISKS = [
  { id: "selfharm", label: "Sebepoškozování" },
  { id: "violence", label: "Násilí" },
  { id: "threats", label: "Hrozby" },
  { id: "abuse", label: "Zneužívání" },
  { id: "boundaries", label: "Hranice" },
  { id: "none", label: "Žádné" },
];

const THEMES = [
  { value: "trauma", label: "Trauma" },
  { value: "relationships", label: "Vztahy" },
  { value: "anxiety", label: "Úzkost" },
  { value: "depression", label: "Deprese" },
  { value: "child-family", label: "Dítě & rodina" },
  { value: "addiction", label: "Závislosti" },
  { value: "other", label: "Jiné" },
];

const SessionReportForm = () => {
  const {
    activeSession,
    activeSessionId,
    updateFormData,
    updateReportText,
    updateTriageData,
    updateStatus,
  } = useActiveSessions();

  const { messages: chatMessages } = useChatContext();
  const [isPrefilling, setIsPrefilling] = useState(false);
  const [isTriaging, setIsTriaging] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll form down as chat progresses
  const chatMessageCount = activeSession?.chatMessages?.length ?? 0;
  useEffect(() => {
    if (scrollRef.current && chatMessageCount > 0) {
      const el = scrollRef.current;
      // Scroll proportionally — keep form flowing with chat
      const scrollTarget = Math.min(
        el.scrollHeight - el.clientHeight,
        el.scrollTop + 120
      );
      el.scrollTo({ top: scrollTarget, behavior: "smooth" });
    }
  }, [chatMessageCount]);

  if (!activeSession || !activeSessionId) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm p-8">
        <p>Vyber sezení v postranním panelu.</p>
      </div>
    );
  }

  const formData = activeSession.formData;
  const triageData = activeSession.triageData;
  const reportText = activeSession.reportText;
  const hasMainChatMessages = chatMessages.length > 1;

  const setField = (field: keyof ReportFormData, value: any) => {
    updateFormData(activeSessionId, { [field]: value });
  };

  const handleEmotionChange = (id: string, checked: boolean) => {
    const next = checked
      ? [...formData.therapistEmotions, id]
      : formData.therapistEmotions.filter(e => e !== id);
    setField("therapistEmotions", next);
  };

  const handleRiskChange = (id: string, checked: boolean) => {
    const next = checked
      ? [...formData.risks, id]
      : formData.risks.filter(r => r !== id);
    setField("risks", next);
  };

  const handlePrefill = async () => {
    if (!hasMainChatMessages) return;
    setIsPrefilling(true);
    try {
      const headers = await getAuthHeaders();
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-prefill`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ messages: chatMessages.slice(-60), hint: "Fill fields A–H. No names/identifiers." }),
        }
      );
      if (!response.ok) throw new Error("Prefill error");
      const data = await response.json();
      updateFormData(activeSessionId, {
        context: data.context || formData.context,
        keyTheme: data.keyTheme || formData.keyTheme,
        therapistEmotions: data.therapistEmotions || formData.therapistEmotions,
        transference: data.transference || formData.transference,
        risks: data.risks || formData.risks,
        missingData: data.missingData || formData.missingData,
        interventionsTried: data.interventionsTried || formData.interventionsTried,
        nextSessionGoal: data.nextSessionGoal || formData.nextSessionGoal,
      });
      toast.success("Formulář předvyplněn z chatu");
    } catch {
      toast.error("Chyba při předvyplňování");
    } finally {
      setIsPrefilling(false);
    }
  };

  const handleTriage = async () => {
    setIsTriaging(true);
    updateTriageData(activeSessionId, null);
    try {
      const headers = await getAuthHeaders();
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-triage`,
        { method: "POST", headers, body: JSON.stringify({ form: formData }) }
      );
      if (!response.ok) throw new Error("Triage error");
      const data = await response.json();
      updateTriageData(activeSessionId, data);
      toast.success("Triage dokončen");
    } catch {
      toast.error("Chyba při triage");
    } finally {
      setIsTriaging(false);
    }
  };

  const handleGenerateReport = async () => {
    setIsGenerating(true);
    updateReportText(activeSessionId, "");
    try {
      const headers = await getAuthHeaders();

      // Include supervision chat context
      const supervisionContext = activeSession.chatMessages.length > 0
        ? activeSession.chatMessages.map(m => `${m.role}: ${m.content}`).join("\n")
        : "";

      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-report`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            form: formData,
            triage: triageData,
            supervisionChat: supervisionContext,
          }),
        }
      );
      if (!response.ok) throw new Error("Report error");
      const data = await response.json();
      updateReportText(activeSessionId, data.report);
      updateStatus(activeSessionId, "report-ready");
      toast.success("Report vygenerován");
    } catch {
      toast.error("Chyba při generování reportu");
    } finally {
      setIsGenerating(false);
    }
  };

  const handleCopyReport = async () => {
    if (!reportText) return;
    await navigator.clipboard.writeText(reportText);
    toast.success("Report zkopírován");
  };

  const handleDownload = (format: "txt" | "md" | "html") => {
    if (!reportText) return;
    const now = new Date();
    const filename = `report_${now.toISOString().slice(0, 10)}_${now.toTimeString().slice(0, 5).replace(":", "")}`;
    let content = format === "md"
      ? `# Report ze sezení\n\n${reportText}`
      : reportText;
    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${filename}.${format}`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`Staženo jako .${format}`);
  };

  return (
    <ScrollArea className="flex-1" ref={scrollRef}>
      <div className="p-4 space-y-5 max-w-2xl">
        <div className="text-center text-xs text-muted-foreground bg-secondary/50 rounded-lg py-2 px-3">
          Sezení: <strong>{activeSession.clientName}</strong> — Karel je připraven v chatu vpravo
        </div>

        {/* Contact Info */}
        <div className="bg-card rounded-xl border border-border p-4 space-y-3">
          <Label className="text-sm font-semibold">Kontaktní údaje</Label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Celé jméno</Label>
              <Input value={formData.contactFullName} onChange={e => setField("contactFullName", e.target.value)} className="h-8 text-sm" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">E-mail</Label>
              <Input type="email" value={formData.contactEmail} onChange={e => setField("contactEmail", e.target.value)} className="h-8 text-sm" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Telefon</Label>
              <Input type="tel" value={formData.contactPhone} onChange={e => setField("contactPhone", e.target.value)} className="h-8 text-sm" />
            </div>
          </div>

          <div className="flex items-center gap-2 pt-1">
            <Switch id="isMinor" checked={formData.isMinor} onCheckedChange={v => setField("isMinor", v)} />
            <Label htmlFor="isMinor" className="text-xs cursor-pointer">Nezletilý klient</Label>
          </div>

          {!formData.isMinor ? (
            <div className="space-y-1">
              <Label className="text-xs">Věk</Label>
              <Input type="number" value={formData.clientAge} onChange={e => setField("clientAge", e.target.value)} className="h-8 text-sm w-24" />
            </div>
          ) : (
            <div className="space-y-3 rounded-lg border border-border p-3 bg-secondary/30">
              <Label className="text-xs font-semibold text-muted-foreground">Údaje o dítěti</Label>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">Jméno dítěte</Label>
                  <Input value={formData.childFullName} onChange={e => setField("childFullName", e.target.value)} className="h-8 text-sm" />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Věk</Label>
                  <Input type="number" value={formData.clientAge} onChange={e => setField("clientAge", e.target.value)} className="h-8 text-sm" />
                </div>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Zákonný zástupce</Label>
                <Input value={formData.guardianFullName} onChange={e => setField("guardianFullName", e.target.value)} className="h-8 text-sm" />
              </div>
            </div>
          )}
        </div>

        {/* Clinical fields */}
        <div className="bg-card rounded-xl border border-border p-4 space-y-4">
          <div className="space-y-1">
            <Label className="text-xs">A) Kontext</Label>
            <Textarea value={formData.context} onChange={e => setField("context", e.target.value)} className="min-h-[70px] text-sm" placeholder="Stručný popis situace" />
          </div>

          <div className="space-y-1">
            <Label className="text-xs">B) Klíčové téma</Label>
            <Select value={formData.keyTheme} onValueChange={v => setField("keyTheme", v)}>
              <SelectTrigger className="h-8 text-sm"><SelectValue placeholder="Vyber téma" /></SelectTrigger>
              <SelectContent>{THEMES.map(t => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}</SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <Label className="text-xs">C) Emoce terapeuta</Label>
            <div className="flex flex-wrap gap-3">
              {EMOTIONS.map(e => (
                <div key={e.id} className="flex items-center gap-1.5">
                  <Checkbox id={`e-${e.id}`} checked={formData.therapistEmotions.includes(e.id)} onCheckedChange={c => handleEmotionChange(e.id, c as boolean)} />
                  <Label htmlFor={`e-${e.id}`} className="text-xs cursor-pointer">{e.label}</Label>
                </div>
              ))}
            </div>
            <Textarea value={formData.therapistEmotionsOther} onChange={e => setField("therapistEmotionsOther", e.target.value)} placeholder="Jiné emoce..." className="min-h-[40px] text-sm mt-1" />
          </div>

          <div className="space-y-1">
            <Label className="text-xs">D) Přenos / protipřenos</Label>
            <Textarea value={formData.transference} onChange={e => setField("transference", e.target.value)} className="min-h-[50px] text-sm" />
          </div>

          <div className="space-y-1">
            <Label className="text-xs">E) Rizika</Label>
            <div className="flex flex-wrap gap-3">
              {RISKS.map(r => (
                <div key={r.id} className="flex items-center gap-1.5">
                  <Checkbox id={`r-${r.id}`} checked={formData.risks.includes(r.id)} onCheckedChange={c => handleRiskChange(r.id, c as boolean)} />
                  <Label htmlFor={`r-${r.id}`} className="text-xs cursor-pointer">{r.label}</Label>
                </div>
              ))}
            </div>
            <Textarea value={formData.risksOther} onChange={e => setField("risksOther", e.target.value)} placeholder="Jiná rizika..." className="min-h-[40px] text-sm mt-1" />
          </div>

          <div className="space-y-1">
            <Label className="text-xs">F) Co potřebuji ověřit</Label>
            <Textarea value={formData.missingData} onChange={e => setField("missingData", e.target.value)} className="min-h-[50px] text-sm" />
          </div>

          <div className="space-y-1">
            <Label className="text-xs">G) Dosavadní intervence</Label>
            <Textarea value={formData.interventionsTried} onChange={e => setField("interventionsTried", e.target.value)} className="min-h-[50px] text-sm" />
          </div>

          <div className="space-y-1">
            <Label className="text-xs">H) Cíl dalšího sezení</Label>
            <Textarea value={formData.nextSessionGoal} onChange={e => setField("nextSessionGoal", e.target.value)} className="min-h-[50px] text-sm" />
          </div>

          {/* Action buttons */}
          <div className="flex flex-wrap gap-2 pt-3 border-t border-border">
            {hasMainChatMessages && (
              <Button variant="outline" size="sm" onClick={handlePrefill} disabled={isPrefilling} className="text-xs h-8">
                {isPrefilling ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Sparkles className="w-3 h-3 mr-1" />}
                Předvyplnit z chatu
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={handleTriage} disabled={isTriaging} className="text-xs h-8">
              {isTriaging ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Lightbulb className="w-3 h-3 mr-1" />}
              Navrhnout otázky
            </Button>
            <Button size="sm" onClick={handleGenerateReport} disabled={isGenerating} className="text-xs h-8">
              {isGenerating ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <FileDown className="w-3 h-3 mr-1" />}
              Vygenerovat report
            </Button>
            <Button variant="ghost" size="sm" className="text-xs h-8" onClick={() => {
              updateFormData(activeSessionId, {
                context: "", keyTheme: "", therapistEmotions: [], therapistEmotionsOther: "",
                transference: "", risks: [], risksOther: "", missingData: "", interventionsTried: "", nextSessionGoal: "",
              });
              updateTriageData(activeSessionId, null);
              updateReportText(activeSessionId, "");
              toast.info("Formulář resetován");
            }}>
              <RotateCcw className="w-3 h-3 mr-1" /> Reset
            </Button>
          </div>
        </div>

        {/* Triage */}
        {triageData && <TriageOutput data={triageData} />}

        {/* Report */}
        {reportText && (
          <ReportOutput report={reportText} onCopy={handleCopyReport} onDownload={handleDownload} />
        )}
      </div>
    </ScrollArea>
  );
};

export default SessionReportForm;
