import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Loader2, Sparkles, FileDown, Copy, RotateCcw, Lightbulb, MessageSquare } from "lucide-react";
import { toast } from "sonner";
import { useChatContext } from "@/contexts/ChatContext";
import TriageOutput from "./TriageOutput";
import ReportOutput from "./ReportOutput";

export interface ReportFormData {
  context: string;
  keyTheme: string;
  therapistEmotions: string[];
  therapistEmotionsOther: string;
  transference: string;
  risks: string[];
  risksOther: string;
  missingData: string;
  interventionsTried: string;
  nextSessionGoal: string;
}

export interface TriageData {
  followUpQuestions: Array<{ q: string; why: string }>;
  criticalDataToCollect: Array<{ item: string; why: string }>;
  contraindicationFlags: Array<{ flag: string; why: string }>;
  recommendedNextSteps: string[];
}

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

const ReportForm = () => {
  const { messages, reportDraft, setReportDraft, setMainMode, setPendingHandoffToChat, setLastReportText } = useChatContext();
  
  const [formData, setFormData] = useState<ReportFormData>({
    context: "",
    keyTheme: "",
    therapistEmotions: [],
    therapistEmotionsOther: "",
    transference: "",
    risks: [],
    risksOther: "",
    missingData: "",
    interventionsTried: "",
    nextSessionGoal: "",
  });

  const [triageData, setTriageData] = useState<TriageData | null>(null);
  const [reportText, setReportText] = useState<string>("");
  const [isPrefilling, setIsPrefilling] = useState(false);
  const [isTriaging, setIsTriaging] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);

  const hasMessages = messages.length > 1;

  // Apply reportDraft when it changes (from SOAP handoff)
  useEffect(() => {
    if (reportDraft) {
      setFormData(prev => ({
        ...prev,
        context: reportDraft.context || prev.context,
        keyTheme: reportDraft.keyTheme || prev.keyTheme,
        therapistEmotions: reportDraft.therapistEmotions || prev.therapistEmotions,
        transference: reportDraft.transference || prev.transference,
        risks: reportDraft.risks || prev.risks,
        missingData: reportDraft.missingData || prev.missingData,
        interventionsTried: reportDraft.interventionsTried || prev.interventionsTried,
        nextSessionGoal: reportDraft.nextSessionGoal || prev.nextSessionGoal,
      }));
      // Clear the draft after applying
      setReportDraft(null);
    }
  }, [reportDraft, setReportDraft]);

  const handleEmotionChange = (emotionId: string, checked: boolean) => {
    setFormData(prev => ({
      ...prev,
      therapistEmotions: checked
        ? [...prev.therapistEmotions, emotionId]
        : prev.therapistEmotions.filter(e => e !== emotionId),
    }));
  };

  const handleRiskChange = (riskId: string, checked: boolean) => {
    setFormData(prev => ({
      ...prev,
      risks: checked
        ? [...prev.risks, riskId]
        : prev.risks.filter(r => r !== riskId),
    }));
  };

  const handlePrefill = async () => {
    if (!hasMessages) return;
    setIsPrefilling(true);

    try {
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-prefill`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
          },
          body: JSON.stringify({
            messages: messages.slice(-60),
            hint: "Fill fields A–H. No names/identifiers.",
          }),
        }
      );

      if (!response.ok) throw new Error("Prefill error");

      const data = await response.json();
      
      setFormData(prev => ({
        ...prev,
        context: data.context || prev.context,
        keyTheme: data.keyTheme || prev.keyTheme,
        therapistEmotions: data.therapistEmotions || prev.therapistEmotions,
        transference: data.transference || prev.transference,
        risks: data.risks || prev.risks,
        missingData: data.missingData || prev.missingData,
        interventionsTried: data.interventionsTried || prev.interventionsTried,
        nextSessionGoal: data.nextSessionGoal || prev.nextSessionGoal,
      }));

      toast.success("Formulář předvyplněn z chatu");
    } catch (error) {
      console.error("Prefill error:", error);
      toast.error("Chyba při předvyplňování");
    } finally {
      setIsPrefilling(false);
    }
  };

  const handleTriage = async () => {
    setIsTriaging(true);
    setTriageData(null);

    try {
      const contextFromChat = hasMessages 
        ? messages.slice(-30).map(m => `${m.role}: ${m.content}`).join("\n")
        : undefined;

      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-triage`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
          },
          body: JSON.stringify({
            form: formData,
            contextFromChat,
          }),
        }
      );

      if (!response.ok) throw new Error("Triage error");

      const data = await response.json();
      setTriageData(data);
      toast.success("Triage dokončen");
    } catch (error) {
      console.error("Triage error:", error);
      toast.error("Chyba při triage");
    } finally {
      setIsTriaging(false);
    }
  };

  const handleGenerateReport = async () => {
    setIsGenerating(true);
    setReportText("");

    try {
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-report`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
          },
          body: JSON.stringify({
            form: formData,
            triage: triageData,
          }),
        }
      );

      if (!response.ok) throw new Error("Report error");

      const data = await response.json();
      setReportText(data.report);
      toast.success("Report vygenerován");
    } catch (error) {
      console.error("Report error:", error);
      toast.error("Chyba při generování reportu");
    } finally {
      setIsGenerating(false);
    }
  };

  const handleCopyReport = async () => {
    if (!reportText) return;
    await navigator.clipboard.writeText(reportText);
    toast.success("Report zkopírován do schránky");
  };

  const handleDownload = (format: "txt" | "md") => {
    if (!reportText) return;
    const blob = new Blob([reportText], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `report-sezeni.${format}`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`Staženo jako .${format}`);
  };

  const handleReset = () => {
    setFormData({
      context: "",
      keyTheme: "",
      therapistEmotions: [],
      therapistEmotionsOther: "",
      transference: "",
      risks: [],
      risksOther: "",
      missingData: "",
      interventionsTried: "",
      nextSessionGoal: "",
    });
    setTriageData(null);
    setReportText("");
    toast.info("Formulář resetován");
  };

  return (
    <div className="max-w-4xl mx-auto py-6 px-4 space-y-6">
      {/* Header note */}
      <div className="text-center text-sm text-muted-foreground bg-secondary/50 rounded-lg py-2 px-4">
        Bez jmen a identifikátorů.
      </div>

      {/* Form */}
      <div className="space-y-6 bg-card rounded-xl border border-border p-6">
        {/* A) Context */}
        <div className="space-y-2">
          <Label htmlFor="context">A) Kontext</Label>
          <Textarea
            id="context"
            placeholder="Stručný popis situace (bez jmen a identifikátorů)"
            value={formData.context}
            onChange={(e) => setFormData(prev => ({ ...prev, context: e.target.value }))}
            className="min-h-[100px]"
          />
        </div>

        {/* B) Key Theme */}
        <div className="space-y-2">
          <Label>B) Klíčové téma</Label>
          <Select value={formData.keyTheme} onValueChange={(value) => setFormData(prev => ({ ...prev, keyTheme: value }))}>
            <SelectTrigger>
              <SelectValue placeholder="Vyber téma" />
            </SelectTrigger>
            <SelectContent>
              {THEMES.map(theme => (
                <SelectItem key={theme.value} value={theme.value}>{theme.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* C) Therapist Emotions */}
        <div className="space-y-2">
          <Label>C) Emoce terapeuta</Label>
          <div className="flex flex-wrap gap-4">
            {EMOTIONS.map(emotion => (
              <div key={emotion.id} className="flex items-center gap-2">
                <Checkbox
                  id={`emotion-${emotion.id}`}
                  checked={formData.therapistEmotions.includes(emotion.id)}
                  onCheckedChange={(checked) => handleEmotionChange(emotion.id, checked as boolean)}
                />
                <Label htmlFor={`emotion-${emotion.id}`} className="text-sm font-normal cursor-pointer">
                  {emotion.label}
                </Label>
              </div>
            ))}
          </div>
          <Textarea
            placeholder="Jiné emoce..."
            value={formData.therapistEmotionsOther}
            onChange={(e) => setFormData(prev => ({ ...prev, therapistEmotionsOther: e.target.value }))}
            className="min-h-[60px] mt-2"
          />
        </div>

        {/* D) Transference */}
        <div className="space-y-2">
          <Label htmlFor="transference">D) Přenos / protipřenos</Label>
          <Textarea
            id="transference"
            placeholder="Co se ve mně spustilo?"
            value={formData.transference}
            onChange={(e) => setFormData(prev => ({ ...prev, transference: e.target.value }))}
            className="min-h-[80px]"
          />
        </div>

        {/* E) Risks */}
        <div className="space-y-2">
          <Label>E) Rizika</Label>
          <div className="flex flex-wrap gap-4">
            {RISKS.map(risk => (
              <div key={risk.id} className="flex items-center gap-2">
                <Checkbox
                  id={`risk-${risk.id}`}
                  checked={formData.risks.includes(risk.id)}
                  onCheckedChange={(checked) => handleRiskChange(risk.id, checked as boolean)}
                />
                <Label htmlFor={`risk-${risk.id}`} className="text-sm font-normal cursor-pointer">
                  {risk.label}
                </Label>
              </div>
            ))}
          </div>
          <Textarea
            placeholder="Jiná rizika..."
            value={formData.risksOther}
            onChange={(e) => setFormData(prev => ({ ...prev, risksOther: e.target.value }))}
            className="min-h-[60px] mt-2"
          />
        </div>

        {/* F) Missing Data */}
        <div className="space-y-2">
          <Label htmlFor="missingData">F) Co potřebuji příště ověřit</Label>
          <Textarea
            id="missingData"
            placeholder="Jaká data mi chybí?"
            value={formData.missingData}
            onChange={(e) => setFormData(prev => ({ ...prev, missingData: e.target.value }))}
            className="min-h-[80px]"
          />
        </div>

        {/* G) Interventions Tried */}
        <div className="space-y-2">
          <Label htmlFor="interventionsTried">G) Dosavadní intervence</Label>
          <Textarea
            id="interventionsTried"
            placeholder="Co jsem zkusila?"
            value={formData.interventionsTried}
            onChange={(e) => setFormData(prev => ({ ...prev, interventionsTried: e.target.value }))}
            className="min-h-[80px]"
          />
        </div>

        {/* H) Next Session Goal */}
        <div className="space-y-2">
          <Label htmlFor="nextSessionGoal">H) Cíl dalšího sezení</Label>
          <Textarea
            id="nextSessionGoal"
            placeholder="Na co se zaměřit příště?"
            value={formData.nextSessionGoal}
            onChange={(e) => setFormData(prev => ({ ...prev, nextSessionGoal: e.target.value }))}
            className="min-h-[80px]"
          />
        </div>

        {/* Action Buttons */}
        <div className="flex flex-wrap gap-3 pt-4 border-t border-border">
          {hasMessages && (
            <Button variant="outline" onClick={handlePrefill} disabled={isPrefilling}>
              {isPrefilling ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Sparkles className="w-4 h-4 mr-2" />}
              Předvyplnit z chatu
            </Button>
          )}
          <Button variant="outline" onClick={handleTriage} disabled={isTriaging}>
            {isTriaging ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Lightbulb className="w-4 h-4 mr-2" />}
            Navrhnout doplňující otázky
          </Button>
          <Button onClick={handleGenerateReport} disabled={isGenerating}>
            {isGenerating ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <FileDown className="w-4 h-4 mr-2" />}
            Vygenerovat report
          </Button>
          <Button variant="ghost" onClick={handleReset}>
            <RotateCcw className="w-4 h-4 mr-2" />
            Nový report
          </Button>
        </div>
      </div>

      {/* Triage Output */}
      {triageData && <TriageOutput data={triageData} />}

      {/* Report Output */}
      {reportText && (
        <>
          <ReportOutput 
            report={reportText} 
            onCopy={handleCopyReport}
            onDownload={handleDownload}
          />
          
          {/* Handoff to Chat CTA */}
          <div className="bg-card rounded-xl border border-border p-6 space-y-4">
            <p className="text-center text-foreground font-medium">
              Chceš si tuto situaci ještě v klidu probrat s Karlem?
            </p>
            <div className="flex justify-center gap-4">
              <Button 
                variant="default" 
                size="lg"
                onClick={() => {
                  setLastReportText(reportText);
                  setPendingHandoffToChat(true);
                  setMainMode("chat");
                }}
                className="gap-2"
              >
                <MessageSquare className="w-4 h-4" />
                Ano, pojďme to probrat
              </Button>
              <Button 
                variant="outline" 
                size="lg"
                onClick={() => {
                  toast.info("Report zůstává k dispozici pro kopírování nebo stažení.");
                }}
              >
                Teď ne
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
};

export default ReportForm;
