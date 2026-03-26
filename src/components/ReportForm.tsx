import { useState, useEffect } from "react";
import { getAuthHeaders } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Loader2, Sparkles, FileDown, Copy, RotateCcw, Lightbulb, MessageSquare, UserPlus, FolderOpen } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useChatContext } from "@/contexts/ChatContext";
import TriageOutput from "./TriageOutput";
import ReportOutput from "./ReportOutput";

export interface ReportFormData {
  contactFullName: string;
  contactEmail: string;
  contactPhone: string;
  isMinor: boolean;
  clientAge: string;
  childFullName: string;
  childEmail: string;
  childPhone: string;
  guardianFullName: string;
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

type ClientOption = { id: string; name: string };

const ReportForm = () => {
  const { messages, reportDraft, setReportDraft, setMainMode, setPendingHandoffToChat, setLastReportText } = useChatContext();
  
  // Client selector state
  const [clients, setClients] = useState<ClientOption[]>([]);
  const [selectedClientId, setSelectedClientId] = useState<string>("");
  const [isCreatingClient, setIsCreatingClient] = useState(false);
  const [newClientName, setNewClientName] = useState("");
  const [isSavingSession, setIsSavingSession] = useState(false);

  const [formData, setFormData] = useState<ReportFormData>({
    contactFullName: "",
    contactEmail: "",
    contactPhone: "",
    isMinor: false,
    clientAge: "",
    childFullName: "",
    childEmail: "",
    childPhone: "",
    guardianFullName: "",
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

  // Fetch clients from DB
  useEffect(() => {
    const fetchClients = async () => {
      const { data, error } = await supabase
        .from("clients")
        .select("id, name")
        .order("name");
      if (!error && data) {
        setClients(data);
      }
    };
    fetchClients();
  }, []);

  // Create new client
  const handleCreateClient = async () => {
    if (!newClientName.trim()) return;
    setIsCreatingClient(true);
    try {
      const { data, error } = await supabase
        .from("clients")
        .insert({ name: newClientName.trim() })
        .select("id, name")
        .single();
      if (error) throw error;
      if (data) {
        setClients(prev => [...prev, data].sort((a, b) => a.name.localeCompare(b.name)));
        setSelectedClientId(data.id);
        setNewClientName("");
        toast.success(`Klient „${data.name}" vytvořen`);
      }
    } catch (error) {
      console.error("Create client error:", error);
      toast.error("Nepodařilo se vytvořit klienta");
    } finally {
      setIsCreatingClient(false);
    }
  };

  // Save session to client_sessions
  const saveSessionToClient = async (clientId: string, report: string) => {
    if (!clientId) return;
    setIsSavingSession(true);
    try {
      // Count existing sessions for session_number
      const { count } = await supabase
        .from("client_sessions")
        .select("id", { count: "exact", head: true })
        .eq("client_id", clientId);

      const { error } = await supabase
        .from("client_sessions")
        .insert({
          client_id: clientId,
          session_number: (count ?? 0) + 1,
          report_context: formData.context,
          report_key_theme: formData.keyTheme,
          report_therapist_emotions: formData.therapistEmotions,
          report_transference: formData.transference,
          report_risks: formData.risks,
          report_missing_data: formData.missingData,
          report_interventions_tried: formData.interventionsTried,
          report_next_session_goal: formData.nextSessionGoal,
          ai_analysis: report,
          notes: formData.therapistEmotionsOther 
            ? `Další emoce: ${formData.therapistEmotionsOther}` 
            : "",
        });
      if (error) throw error;
      toast.success("Záznam ze sezení uložen ke klientovi");
    } catch (error) {
      console.error("Save session error:", error);
      toast.error("Nepodařilo se uložit záznam ke klientovi");
    } finally {
      setIsSavingSession(false);
    }
  };

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
      const headers = await getAuthHeaders();
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-prefill`,
        {
          method: "POST",
          headers,
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

      const headers = await getAuthHeaders();
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-triage`,
        {
          method: "POST",
          headers,
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
      const headers = await getAuthHeaders();
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-report`,
        {
          method: "POST",
          headers,
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

      // Auto-save to client if selected
      if (selectedClientId && selectedClientId !== "none") {
        await saveSessionToClient(selectedClientId, data.report);
      }
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

  const getTimestamp = () => {
    const now = new Date();
    const date = now.toISOString().slice(0, 10);
    const time = now.toTimeString().slice(0, 5).replace(":", "");
    return { date, time, formatted: `${now.toLocaleDateString("cs-CZ")} ${now.toLocaleTimeString("cs-CZ", { hour: "2-digit", minute: "2-digit" })}` };
  };

  const buildHeader = (formatted: string) =>
    `════════════════════════════════════════\n  Report ze sezení\n  ${formatted}\n════════════════════════════════════════\n\n`;

  const buildHtml = (reportMarkdown: string, formatted: string) => `<!DOCTYPE html>
<html lang="cs">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Report ze sezení – ${formatted}</title>
<style>
  body { font-family: Georgia, 'Times New Roman', serif; max-width: 700px; margin: 2rem auto; padding: 0 1.5rem; color: #1a1a1a; line-height: 1.6; }
  h1 { font-size: 1.4rem; border-bottom: 2px solid #333; padding-bottom: .4rem; }
  h2 { font-size: 1.1rem; margin-top: 1.5rem; color: #444; }
  h3 { font-size: 1rem; color: #555; }
  ul { padding-left: 1.2rem; }
  li { margin: .3rem 0; }
  .meta { color: #888; font-size: .85rem; margin-bottom: 1.5rem; }
  .footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid #ddd; font-size: .75rem; color: #aaa; text-align: center; }
  @media print { body { margin: 0; } .footer { display: none; } }
</style>
</head>
<body>
<h1>Report ze sezení</h1>
<p class="meta">${formatted}</p>
${simpleMarkdownToHtml(reportMarkdown)}
<div class="footer">Vygenerováno lokálně · žádná data nebyla odeslána</div>
</body>
</html>`;

  const simpleMarkdownToHtml = (md: string): string => {
    return md
      .split("\n")
      .map(line => {
        if (line.startsWith("### ")) return `<h3>${line.slice(4)}</h3>`;
        if (line.startsWith("## ")) return `<h2>${line.slice(3)}</h2>`;
        if (line.startsWith("# ")) return `<h1>${line.slice(2)}</h1>`;
        if (line.startsWith("- ")) return `<li>${line.slice(2)}</li>`;
        if (line.startsWith("**") && line.endsWith("**")) return `<p><strong>${line.slice(2, -2)}</strong></p>`;
        if (line.trim() === "") return "";
        return `<p>${line}</p>`;
      })
      .join("\n")
      .replace(/(<li>.*<\/li>\n?)+/g, match => `<ul>${match}</ul>`);
  };

  const handleDownload = (format: "txt" | "md" | "html") => {
    if (!reportText) return;
    const { date, time, formatted } = getTimestamp();
    const filename = `report_${date}_${time}`;

    let content: string;
    let mimeType: string;

    switch (format) {
      case "html":
        content = buildHtml(reportText, formatted);
        mimeType = "text/html";
        break;
      case "md":
        content = `# Report ze sezení\n\n> ${formatted}\n\n---\n\n${reportText}`;
        mimeType = "text/markdown";
        break;
      default:
        content = `${buildHeader(formatted)}${reportText}`;
        mimeType = "text/plain";
    }

    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${filename}.${format}`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`Staženo jako .${format}`);
  };

  const handleReset = () => {
    setFormData({
      contactFullName: "",
      contactEmail: "",
      contactPhone: "",
      isMinor: false,
      clientAge: "",
      childFullName: "",
      childEmail: "",
      childPhone: "",
      guardianFullName: "",
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
    setSelectedClientId("");
    setNewClientName("");
    toast.info("Formulář resetován");
  };

  return (
    <div className="max-w-4xl mx-auto py-6 px-4 space-y-6">
      {/* Header note */}
      <div className="text-center text-sm text-muted-foreground bg-secondary/50 rounded-lg py-2 px-4">
        Bez jmen a identifikátorů v textu. Klienta vyber z kartotéky níže.
      </div>

      {/* Client Selector */}
      <div className="bg-card rounded-xl border border-border p-4 space-y-3">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <FolderOpen className="w-4 h-4" />
          Přiřadit ke klientovi (volitelné)
        </div>
        <div className="flex flex-wrap gap-2 items-end">
          <div className="flex-1 min-w-[12.5rem]">
            <Select value={selectedClientId} onValueChange={setSelectedClientId}>
              <SelectTrigger>
                <SelectValue placeholder="Vybrat klienta..." />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">— Bez klienta —</SelectItem>
                {clients.map(c => (
                  <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex gap-2 items-end">
            <Input
              placeholder="Nový klient..."
              value={newClientName}
              onChange={(e) => setNewClientName(e.target.value)}
              className="w-40"
              onKeyDown={(e) => { if (e.key === "Enter") handleCreateClient(); }}
            />
            <Button 
              variant="outline" 
              size="sm" 
              onClick={handleCreateClient}
              disabled={!newClientName.trim() || isCreatingClient}
            >
              {isCreatingClient ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserPlus className="w-4 h-4" />}
            </Button>
          </div>
        </div>
        {selectedClientId && selectedClientId !== "none" && (
          <p className="text-xs text-muted-foreground">
            ✓ Report bude automaticky uložen jako záznam ze sezení tohoto klienta.
          </p>
        )}
      </div>

      {/* Contact Info */}
      <div className="bg-card rounded-xl border border-border p-6 space-y-4">
        <Label className="text-base font-semibold">Kontaktní údaje klienta</Label>
        
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="contactFullName">Celé jméno a příjmení</Label>
            <Input
              id="contactFullName"
              placeholder="Jan Novák"
              value={formData.contactFullName}
              onChange={(e) => setFormData(prev => ({ ...prev, contactFullName: e.target.value }))}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="contactEmail">E-mail</Label>
            <Input
              id="contactEmail"
              type="email"
              placeholder="jan@email.cz"
              value={formData.contactEmail}
              onChange={(e) => setFormData(prev => ({ ...prev, contactEmail: e.target.value }))}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="contactPhone">Telefon</Label>
            <Input
              id="contactPhone"
              type="tel"
              placeholder="+420 ..."
              value={formData.contactPhone}
              onChange={(e) => setFormData(prev => ({ ...prev, contactPhone: e.target.value }))}
            />
          </div>
        </div>

        {/* Adult / Minor toggle */}
        <div className="flex items-center gap-3 pt-2">
          <Switch
            id="isMinor"
            checked={formData.isMinor}
            onCheckedChange={(checked) => setFormData(prev => ({ ...prev, isMinor: checked }))}
          />
          <Label htmlFor="isMinor" className="font-normal cursor-pointer">Nezletilý klient</Label>
        </div>

        {!formData.isMinor ? (
          <div className="space-y-2">
            <Label htmlFor="clientAge">Věk</Label>
            <Input
              id="clientAge"
              type="number"
              placeholder="Věk klienta"
              value={formData.clientAge}
              onChange={(e) => setFormData(prev => ({ ...prev, clientAge: e.target.value }))}
              className="w-32"
            />
          </div>
        ) : (
          <div className="space-y-4 rounded-lg border border-border p-4 bg-secondary/30">
            <Label className="text-sm font-semibold text-muted-foreground">Údaje o dítěti</Label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="childFullName">Jméno a příjmení dítěte</Label>
                <Input
                  id="childFullName"
                  placeholder="Jana Nováková"
                  value={formData.childFullName}
                  onChange={(e) => setFormData(prev => ({ ...prev, childFullName: e.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="clientAge">Věk dítěte</Label>
                <Input
                  id="clientAge"
                  type="number"
                  placeholder="Věk"
                  value={formData.clientAge}
                  onChange={(e) => setFormData(prev => ({ ...prev, clientAge: e.target.value }))}
                  className="w-32"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="childEmail">E-mail dítěte (pokud má)</Label>
                <Input
                  id="childEmail"
                  type="email"
                  placeholder="volitelné"
                  value={formData.childEmail}
                  onChange={(e) => setFormData(prev => ({ ...prev, childEmail: e.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="childPhone">Telefon dítěte (pokud má)</Label>
                <Input
                  id="childPhone"
                  type="tel"
                  placeholder="volitelné"
                  value={formData.childPhone}
                  onChange={(e) => setFormData(prev => ({ ...prev, childPhone: e.target.value }))}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="guardianFullName">Zákonný zástupce / opatrující osoba</Label>
              <Input
                id="guardianFullName"
                placeholder="Jméno a příjmení zástupce"
                value={formData.guardianFullName}
                onChange={(e) => setFormData(prev => ({ ...prev, guardianFullName: e.target.value }))}
              />
            </div>
          </div>
        )}
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
            className="min-h-[6.25rem]"
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
            className="min-h-[3.75rem] mt-2"
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
            className="min-h-[5rem]"
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
            className="min-h-[3.75rem] mt-2"
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
            className="min-h-[5rem]"
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
            className="min-h-[5rem]"
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
            className="min-h-[5rem]"
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
