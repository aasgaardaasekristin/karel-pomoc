import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { getAuthHeaders } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Loader2, ClipboardList, Search, ArrowLeft, CheckCircle, Edit3, Sparkles } from "lucide-react";
import { toast } from "sonner";
import ReactMarkdown from "react-markdown";

type Step = "select-part" | "set-goals" | "generating" | "review" | "revising";

interface Props {
  therapistName: "Hanička" | "Káťa";
}

const DidPersonalizedSessionPrep = ({ therapistName }: Props) => {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>("select-part");
  const [partNames, setPartNames] = useState<string[]>([]);
  const [selectedPart, setSelectedPart] = useState("");
  const [customPart, setCustomPart] = useState("");
  const [filter, setFilter] = useState("");
  const [goalType, setGoalType] = useState<"specific" | "strengthen" | "unknown" | null>(null);
  const [goalText, setGoalText] = useState("");
  const [plan, setPlan] = useState("");
  const [loading, setLoading] = useState(false);
  const [revisionNote, setRevisionNote] = useState("");

  const therapistKey = therapistName === "Hanička" ? "hanka" : "kata";

  useEffect(() => {
    if (!open) {
      setStep("select-part");
      setSelectedPart("");
      setCustomPart("");
      setFilter("");
      setGoalType(null);
      setGoalText("");
      setPlan("");
      setRevisionNote("");
      return;
    }
    (async () => {
      const { data } = await supabase
        .from("did_part_registry")
        .select("part_name, display_name, status")
        .order("status", { ascending: true });
      if (data) {
        const names = data.map(d => d.display_name || d.part_name);
        setPartNames(names);
      }
    })();
  }, [open]);

  const finalPartName = selectedPart || customPart;

  const generatePlan = useCallback(async (revision?: string) => {
    if (!finalPartName) return;
    setLoading(true);
    if (!revision) {
      setPlan("");
      setStep("generating");
    } else {
      setStep("revising");
    }

    try {
      const headers = await getAuthHeaders();
      const resp = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-did-session-prep`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            partName: finalPartName,
            therapist: therapistKey,
            therapistDisplayName: therapistName,
            goalType: goalType || "unknown",
            goalText: goalText || "",
            revision: revision || null,
            previousPlan: revision ? plan : null,
          }),
        }
      );

      if (!resp.ok) {
        if (resp.status === 429) { toast.error("Příliš mnoho požadavků."); setStep("review"); setLoading(false); return; }
        if (resp.status === 402) { toast.error("Nedostatek kreditů."); setStep("review"); setLoading(false); return; }
        toast.error("Chyba při generování plánu.");
        setStep(revision ? "review" : "set-goals");
        setLoading(false);
        return;
      }

      if (!resp.body) { setLoading(false); return; }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let accumulated = revision ? "" : "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let idx: number;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          let line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          if (line.endsWith("\r")) line = line.slice(0, -1);
          if (line.startsWith(":") || line.trim() === "") continue;
          if (!line.startsWith("data: ")) continue;
          const jsonStr = line.slice(6).trim();
          if (jsonStr === "[DONE]") break;
          try {
            const parsed = JSON.parse(jsonStr);
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) {
              accumulated += content;
              setPlan(accumulated);
            }
          } catch { /* partial */ }
        }
      }
      setStep("review");
    } catch (e: any) {
      toast.error(e.message || "Chyba.");
      setStep("set-goals");
    } finally {
      setLoading(false);
    }
  }, [finalPartName, therapistKey, therapistName, goalType, goalText, plan]);

  const filteredParts = partNames.filter(p =>
    !filter || p.toLowerCase().includes(filter.toLowerCase())
  );

  const goalOptions = [
    { id: "specific" as const, label: "Mám konkrétní cíl", icon: "🎯", desc: "Vím, čeho chci v sezení dosáhnout" },
    { id: "strengthen" as const, label: "Chci něco posílit", icon: "💪", desc: "Chci rozvíjet konkrétní dovednost nebo oblast" },
    { id: "unknown" as const, label: "Nevím, poraď mi", icon: "🤔", desc: "Karel navrhne optimální plán sám" },
  ];

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 text-xs gap-1.5">
          <Sparkles className="w-3.5 h-3.5" />
          Příprava na sezení
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-sm flex items-center gap-2">
            <ClipboardList className="w-4 h-4 text-primary" />
            Příprava na sezení — {therapistName}
          </DialogTitle>
        </DialogHeader>

        {/* STEP 1: Select part */}
        {step === "select-part" && (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">Pro jakou část chceš připravit sezení?</p>
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-2 text-muted-foreground" />
              <Input
                value={filter}
                onChange={e => setFilter(e.target.value)}
                placeholder="Vyhledat část..."
                className="pl-8 h-8 text-xs"
              />
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5 max-h-48 overflow-y-auto">
              {filteredParts.map(name => (
                <Button
                  key={name}
                  variant={selectedPart === name ? "default" : "outline"}
                  size="sm"
                  onClick={() => { setSelectedPart(name); setCustomPart(""); }}
                  className="h-8 text-[11px] justify-start truncate"
                >
                  {name}
                </Button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <Input
                value={customPart}
                onChange={e => { setCustomPart(e.target.value); setSelectedPart(""); }}
                placeholder="Nebo napiš jméno části..."
                className="h-8 text-xs flex-1"
              />
            </div>
            <div className="flex justify-end">
              <Button
                size="sm"
                disabled={!finalPartName}
                onClick={() => setStep("set-goals")}
                className="h-8 text-xs"
              >
                Pokračovat →
              </Button>
            </div>
          </div>
        )}

        {/* STEP 2: Set goals */}
        {step === "set-goals" && (
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => setStep("select-part")} className="h-6 text-[10px] px-1.5">
                <ArrowLeft className="w-3 h-3" />
              </Button>
              <p className="text-xs font-medium">Sezení s: <span className="text-primary">{finalPartName}</span></p>
            </div>
            <p className="text-xs text-muted-foreground">Máš pro toto sezení nějaký konkrétní cíl?</p>
            <div className="space-y-2">
              {goalOptions.map(opt => (
                <button
                  key={opt.id}
                  onClick={() => setGoalType(opt.id)}
                  className={`w-full flex items-start gap-3 p-3 rounded-lg border text-left transition-all text-xs ${goalType === opt.id ? "border-primary bg-primary/5" : "border-border hover:border-primary/30"}`}
                >
                  <span className="text-base mt-0.5">{opt.icon}</span>
                  <div>
                    <div className="font-medium text-foreground">{opt.label}</div>
                    <div className="text-muted-foreground mt-0.5">{opt.desc}</div>
                  </div>
                </button>
              ))}
            </div>
            {(goalType === "specific" || goalType === "strengthen") && (
              <Textarea
                value={goalText}
                onChange={e => setGoalText(e.target.value)}
                placeholder={goalType === "specific" ? "Popiš cíl sezení..." : "Co chceš posílit nebo rozvíjet?"}
                className="text-xs min-h-[60px]"
              />
            )}
            <div className="flex justify-end">
              <Button
                size="sm"
                disabled={!goalType || ((goalType === "specific" || goalType === "strengthen") && !goalText.trim())}
                onClick={() => generatePlan()}
                className="h-8 text-xs gap-1.5"
              >
                <Sparkles className="w-3 h-3" />
                Sestavit plán sezení
              </Button>
            </div>
          </div>
        )}

        {/* STEP 3: Generating */}
        {(step === "generating" || step === "revising") && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin text-primary" />
              {step === "revising" ? "Karel upravuje plán..." : "Karel prohledává Drive, internet a sestavuje plán..."}
            </div>
            {plan && (
              <div className="prose prose-sm dark:prose-invert max-w-none text-[11px] leading-relaxed">
                <ReactMarkdown
                  components={{
                    h2: ({ children }) => <h2 className="text-sm font-semibold text-foreground mt-3 mb-1.5 first:mt-0">{children}</h2>,
                    h3: ({ children }) => <h3 className="text-xs font-medium text-foreground mt-2 mb-1">{children}</h3>,
                    p: ({ children }) => <p className="text-muted-foreground mb-2 leading-relaxed">{children}</p>,
                    strong: ({ children }) => <strong className="text-foreground font-semibold">{children}</strong>,
                    li: ({ children }) => <li className="text-muted-foreground ml-3">{children}</li>,
                  }}
                >
                  {plan}
                </ReactMarkdown>
                {loading && <Loader2 className="w-3 h-3 animate-spin text-primary inline-block ml-1" />}
              </div>
            )}
          </div>
        )}

        {/* STEP 4: Review */}
        {step === "review" && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium flex items-center gap-1.5">
                <CheckCircle className="w-3.5 h-3.5 text-green-500" />
                Plán sezení: {finalPartName}
              </p>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => { setStep("select-part"); setPlan(""); setGoalType(null); setGoalText(""); }}
                className="h-6 text-[10px]"
              >
                ← Začít znovu
              </Button>
            </div>
            <div className="prose prose-sm dark:prose-invert max-w-none text-[11px] leading-relaxed border rounded-lg p-3 bg-card/50">
              <ReactMarkdown
                components={{
                  h2: ({ children }) => <h2 className="text-sm font-semibold text-foreground mt-3 mb-1.5 first:mt-0">{children}</h2>,
                  h3: ({ children }) => <h3 className="text-xs font-medium text-foreground mt-2 mb-1">{children}</h3>,
                  p: ({ children }) => <p className="text-muted-foreground mb-2 leading-relaxed">{children}</p>,
                  strong: ({ children }) => <strong className="text-foreground font-semibold">{children}</strong>,
                  li: ({ children }) => <li className="text-muted-foreground ml-3">{children}</li>,
                }}
              >
                {plan}
              </ReactMarkdown>
            </div>
            <div className="border rounded-lg p-3 space-y-2">
              <p className="text-xs font-medium text-foreground flex items-center gap-1.5">
                <Edit3 className="w-3 h-3" />
                Chceš něco změnit?
              </p>
              <Textarea
                value={revisionNote}
                onChange={e => setRevisionNote(e.target.value)}
                placeholder="Napiš co chceš upravit... (např. 'přidej víc hravých aktivit', 'zkrať úvod')"
                className="text-xs min-h-[50px]"
              />
              <div className="flex gap-2 justify-end">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!revisionNote.trim() || loading}
                  onClick={() => { generatePlan(revisionNote); setRevisionNote(""); }}
                  className="h-7 text-[10px] gap-1"
                >
                  <Edit3 className="w-3 h-3" />
                  Upravit plán
                </Button>
                <Button
                  size="sm"
                  onClick={() => { toast.success("Plán sezení připraven! 🎯"); setOpen(false); }}
                  className="h-7 text-[10px] gap-1"
                >
                  <CheckCircle className="w-3 h-3" />
                  Schválit plán
                </Button>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};

export default DidPersonalizedSessionPrep;
