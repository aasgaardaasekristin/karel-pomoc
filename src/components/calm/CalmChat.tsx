import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Send, Loader2, Phone, ShieldAlert, HeartHandshake } from "lucide-react";
import { toast } from "sonner";
import ReactMarkdown from "react-markdown";
import type { CalmScenario } from "./ScenarioSelector";
import { useCrisisSupervision } from "@/contexts/CrisisSupervisionContext";
import type { CrisisImprint, DiagnosticProfile } from "@/types/crisisImprint";

type Message = { role: "user" | "assistant"; content: string };

const scenarioFirstMessages: Record<CalmScenario, string> = {
  panic: "Dýchej. Jsi v bezpečí, i když to tak teď necítíš.\n\nŘekni mi jedním slovem – co teď cítíš nejvíc?",
  insomnia: "Chápu, noci můžou být hodně dlouhé.\n\nPověz mi – je to spíš myšlenky, co tě drží vzhůru, nebo napětí v těle?",
  overwhelm: "To je hodně. A je v pořádku, že to tak cítíš.\n\nCo z toho všeho teď tlačí nejvíc?",
  sadness: "Jsem tady. Nemusíš nic vysvětlovat.\n\nChceš mi říct, jak se to v tobě teď projevuje?",
  relationship: "Vztahové věci bolí úplně jinak.\n\nCo se teď děje – hádka, ticho, nebo něco jiného?",
  threat: "Slyším tě. Tvoje bezpečí je teď nejdůležitější.\n\nJsi teď na bezpečném místě?",
  child_anxiety: "Vím, jak moc to bolí, když vidíš, že tvé dítě trpí.\n\nCo se teď děje?",
  work_stress: "Pracovní tlak umí drtit.\n\nCo teď nejvíc potřebuješ – zklidnit se, nebo si ulevit?",
  somatic: "Tělesné příznaky úzkosti jsou děsivé, ale dají se zklidnit.\n\nCo teď cítíš – bušení srdce, závratě, nebo něco jiného?",
  shame: "Těžké pocity jako stud nebo vina umí hodně drtit. Jsem tady.\n\nChceš mi říct, co to vyvolalo?",
  rumination: "Myšlenky, co se točí dokola, jsou vyčerpávající.\n\nZkus mi jednou větou říct, co se v tobě teď opakuje.",
  dissociation: "Rozumím. Pocit, že jsi mimo sebe, může být děsivý.\n\nCo teď vidíš kolem sebe? Zkus popsat jednu věc.",
  other: "Jsem tady, ať je to cokoliv.\n\nPověz mi jednou větou, co se teď děje.",
};

const RISK_SCORE_REGEX = /\[RISK_SCORE:(\d+)\]/g;

function stripRiskMarkers(text: string): string {
  return text.replace(RISK_SCORE_REGEX, "").replace(/\[RISK:HIGH\]/g, "").trim();
}

function extractRiskScore(text: string): number | null {
  const matches = [...text.matchAll(RISK_SCORE_REGEX)];
  if (matches.length === 0) return null;
  // Take the last (most recent) score
  return parseInt(matches[matches.length - 1][1], 10);
}

interface CalmChatProps {
  scenario: CalmScenario;
  onEnd: () => void;
}

const CalmChat = ({ scenario, onEnd }: CalmChatProps) => {
  const [messages, setMessages] = useState<Message[]>([
    { role: "assistant", content: scenarioFirstMessages[scenario] },
  ]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [riskScore, setRiskScore] = useState(0);
  const [showTherapistBridge, setShowTherapistBridge] = useState(false);
  const [therapistBridgeAccepted, setTherapistBridgeAccepted] = useState(false);
  const [therapistBridgeMethod, setTherapistBridgeMethod] = useState<"email" | "sms" | null>(null);
  const [messageCount, setMessageCount] = useState(0);
  const [crisisImprintSent, setCrisisImprintSent] = useState(false);
  const [riskHistory, setRiskHistory] = useState<number[]>([]);
  const [sessionStart] = useState(Date.now());
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { addImprint } = useCrisisSupervision();

  const riskLevel = riskScore >= 9 ? "high" : riskScore >= 5 ? "elevated" : "normal";

  // Show therapist bridge after sustained high risk (enough messages exchanged after risk threshold)
  useEffect(() => {
    if (riskScore >= 9 && messageCount >= 6 && !therapistBridgeAccepted) {
      setShowTherapistBridge(true);
    }
  }, [riskScore, messageCount, therapistBridgeAccepted]);

  // Create crisis imprint when conditions are met
  // Build diagnostic profile from conversation analysis
  const buildDiagnosticProfile = (): DiagnosticProfile => {
    const userMessages = messages.filter(m => m.role === "user").map(m => m.content);
    const avgLength = userMessages.length > 0 
      ? userMessages.reduce((sum, m) => sum + m.length, 0) / userMessages.length 
      : 0;

    // Analyze response length
    const responseLength: DiagnosticProfile["cognitiveProfile"]["responseLength"] = 
      avgLength < 20 ? "short" : avgLength > 100 ? "long" : "normal";

    // Analyze concentration (do responses stay on topic or drift?)
    const hasRepetition = userMessages.some((m, i) => 
      i > 0 && userMessages[i - 1].toLowerCase().includes(m.toLowerCase().slice(0, 10))
    );
    const concentration: DiagnosticProfile["cognitiveProfile"]["concentration"] = 
      userMessages.length < 3 ? "unknown" : hasRepetition ? "low" : "medium";

    // Analyze cooperation
    const refusals = userMessages.filter(m => 
      /ne(chci|mám|budu)|nech\s*m[eě]|nemůžu|nic|jedno/i.test(m)
    ).length;
    const cooperationLevel: DiagnosticProfile["emotionalSignals"]["cooperationLevel"] = 
      refusals > userMessages.length / 2 ? "resistant" : 
      refusals > 0 ? "passive" : "active";

    // Analyze state change
    const stateChange: DiagnosticProfile["emotionalSignals"]["stateChange"] = 
      riskHistory.length < 2 ? "unknown" :
      riskHistory[riskHistory.length - 1] < riskHistory[0] ? "improving" :
      riskHistory[riskHistory.length - 1] > riskHistory[0] ? "worsening" : "stable";

    // Detect aggressive impulses in text
    const aggressiveKeywords = /zab[ií]|nená|vztekl|agres|ublíž|rozbí|zniči|nenávi/i;
    const aggressiveCount = userMessages.filter(m => aggressiveKeywords.test(m)).length;
    const aggressiveImpulses: DiagnosticProfile["emotionalSignals"]["aggressiveImpulses"] = 
      aggressiveCount === 0 ? "none" : 
      aggressiveCount === 1 ? "mild" : 
      aggressiveCount <= 3 ? "moderate" : "severe";

    return {
      cognitiveProfile: {
        concentration,
        flexibility: userMessages.length < 3 ? "unknown" : "medium",
        thinkingStyle: "unknown",
        responseSpeed: "unknown",
        responseLength,
      },
      emotionalSignals: {
        frustrationReaction: refusals > 2 ? "escalating" : refusals > 0 ? "avoidant" : "adaptive",
        cooperationLevel,
        stateChange,
        aggressiveImpulses,
      },
      projectionContent: [],
      activityEngagement: {
        activitiesOffered: [],
        activitiesAccepted: [],
        activitiesRejected: [],
      },
      diagnosticHypothesis: "",
    };
  };

  // Extract key conversation excerpts for the brief
  const getConversationExcerpts = (): string[] => {
    const userMessages = messages.filter(m => m.role === "user");
    const significantPatterns = /smrt|konec|zmiz|nemá.*smysl|nechci.*žít|ublíž|strach|ohrož|nás|bil|doma|nebezpeč|krev|bolest|sám|sama|opuštěn/i;
    return userMessages
      .filter(m => significantPatterns.test(m.content))
      .map(m => m.content.slice(0, 200))
      .slice(0, 5);
  };

  // Create crisis imprint when conditions are met
  useEffect(() => {
    if (crisisImprintSent) return;
    const shouldTrigger =
      riskScore >= 7 ||
      (therapistBridgeAccepted && therapistBridgeMethod !== null);
    
    console.log("CRISIS_IMPRINT_CHECK", { riskScore, shouldTrigger, therapistBridgeAccepted });

    if (!shouldTrigger) return;

    const escalationPattern = riskHistory.length >= 3
      ? (riskHistory[riskHistory.length - 1] - riskHistory[0] > 4 ? "rapid" : "gradual")
      : "stable";

    const diagnosticProfile = buildDiagnosticProfile();
    const conversationExcerpts = getConversationExcerpts();

    const imprint: CrisisImprint = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      scenario,
      riskScore,
      signals: {
        hopelessness: riskScore >= 7,
        regulationFailure: messageCount >= 8 && riskScore >= 9,
        helpRefusal: showTherapistBridge && !therapistBridgeAccepted,
        selfHarm: riskScore >= 12,
        domesticThreat: scenario === "threat",
        narrowedFuture: riskScore >= 10,
      },
      regulationAttempts: Math.max(1, Math.floor(messageCount / 3)),
      regulationSuccessful: riskScore < 5,
      therapistBridgeTriggered: therapistBridgeAccepted,
      therapistBridgeMethod,
      timeDynamics: {
        sessionDurationMs: Date.now() - sessionStart,
        messageCount,
        riskEscalationPattern: escalationPattern,
      },
      diagnosticProfile,
      conversationExcerpts,
      note: "Uživatel může terapeutku kontaktovat sám (kód 11)",
    };

    addImprint(imprint);
    setCrisisImprintSent(true);
    console.log("CRISIS_IMPRINT_GENERATED", { id: imprint.id, riskScore, scenario, diagnosticProfile });

    // Fire-and-forget: call edge function to generate brief, store in DB, and notify therapist
    fetch(
      `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-crisis-brief`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
        },
        body: JSON.stringify({ imprint }),
      }
    ).then(res => {
      if (res.ok) console.log("CRISIS_BRIEF_GENERATED_AND_STORED");
      else console.error("CRISIS_BRIEF_GENERATION_FAILED", res.status);
    }).catch(err => console.error("CRISIS_BRIEF_ERROR", err));
  }, [riskScore, therapistBridgeAccepted, therapistBridgeMethod, crisisImprintSent, messageCount, scenario, riskHistory, showTherapistBridge, sessionStart, addImprint, messages]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const sendMessage = async () => {
    if (!input.trim() || isLoading) return;

    const userMessage = input.trim();
    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: userMessage }]);
    setMessageCount((c) => c + 1);
    setIsLoading(true);

    let assistantContent = "";

    try {
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-calm`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
          },
          body: JSON.stringify({
            messages: [...messages, { role: "user", content: userMessage }],
            scenario,
          }),
        }
      );

      if (!response.ok) throw new Error("Chyba spojení");
      if (!response.body) throw new Error("Žádná odpověď");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      setMessages((prev) => [...prev, { role: "assistant", content: "" }]);

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        let newlineIndex: number;
        while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
          let line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);

          if (line.endsWith("\r")) line = line.slice(0, -1);
          if (line.startsWith(":") || line.trim() === "") continue;
          if (!line.startsWith("data: ")) continue;

          const jsonStr = line.slice(6).trim();
          if (jsonStr === "[DONE]") break;

          try {
            const parsed = JSON.parse(jsonStr);
            const content = parsed.choices?.[0]?.delta?.content as string | undefined;
            if (content) {
              assistantContent += content;

              // Extract risk score from the raw content
              const score = extractRiskScore(assistantContent);
              if (score !== null && score > riskScore) {
                setRiskScore(score);
                setRiskHistory(prev => [...prev, score]);
                if (score >= 9) {
                  console.log("HIGH_RISK", { scenario, riskScore: score });
                }
              }

              const displayContent = stripRiskMarkers(assistantContent);

              setMessages((prev) => {
                const updated = [...prev];
                const lastIdx = updated.length - 1;
                if (updated[lastIdx]?.role === "assistant") {
                  updated[lastIdx] = { ...updated[lastIdx], content: displayContent };
                }
                return updated;
              });
            }
          } catch {
            buffer = line + "\n" + buffer;
            break;
          }
        }
      }
    } catch (error) {
      console.error("Calm chat error:", error);
      toast.error("Něco se pokazilo. Zkus to znovu.");
      if (!assistantContent) {
        setMessages((prev) => prev.slice(0, -1));
      }
    } finally {
      setIsLoading(false);
      textareaRef.current?.focus();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Messages */}
      <ScrollArea className="flex-1 px-4" ref={scrollRef}>
        <div className="max-w-2xl mx-auto py-6 space-y-4">
          {messages.map((msg, i) => (
            <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
              <div className={`max-w-[85%] ${msg.role === "user" ? "chat-message-user" : "chat-message-assistant"}`}>
                <div className="prose prose-sm max-w-none text-foreground prose-a:text-primary prose-a:underline prose-a:font-medium">
                  <ReactMarkdown
                    components={{
                      a: ({ href, children }) => (
                        <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary underline font-medium hover:text-primary/80">
                          {children}
                        </a>
                      ),
                    }}
                  >{msg.content}</ReactMarkdown>
                </div>
              </div>
            </div>
          ))}
          {isLoading && messages[messages.length - 1]?.role === "user" && (
            <div className="flex justify-start">
              <div className="chat-message-assistant flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin text-primary" />
                <span className="text-muted-foreground text-sm">Přemýšlím...</span>
              </div>
            </div>
          )}
        </div>
      </ScrollArea>

      {/* Risk help banner – HIGH risk */}
      {riskLevel === "high" && (
        <div className="border-t border-destructive/30 bg-destructive/5 px-4 py-3">
          <div className="max-w-2xl mx-auto">
            <div className="flex items-center gap-2 mb-2">
              <ShieldAlert className="w-4 h-4 text-destructive" />
              <p className="text-sm text-foreground font-medium">
                Pokud potřebuješ okamžitou pomoc:
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <a href="tel:116123" className="inline-flex">
                <Button variant="outline" size="sm" className="text-xs border-destructive/30">
                  <Phone className="w-3 h-3 mr-1" />
                  Krizová linka (116 123) – dospělí
                </Button>
              </a>
              <a href="tel:116111" className="inline-flex">
                <Button variant="outline" size="sm" className="text-xs border-destructive/30">
                  <Phone className="w-3 h-3 mr-1" />
                  Linka bezpečí (116 111) – děti
                </Button>
              </a>
              <a href="tel:158" className="inline-flex">
                <Button variant="outline" size="sm" className="text-xs border-destructive/30">
                  <Phone className="w-3 h-3 mr-1" />
                  Policie ČR (158)
                </Button>
              </a>
            </div>
          </div>
        </div>
      )}

      {/* Voluntary therapist bridge – HIGH risk, after other options exhausted */}
      {riskLevel === "high" && showTherapistBridge && !therapistBridgeAccepted && (
        <div className="border-t border-primary/20 bg-primary/5 px-4 py-4">
          <div className="max-w-2xl mx-auto space-y-3">
            <div className="flex items-start gap-2">
              <HeartHandshake className="w-5 h-5 text-primary mt-0.5 shrink-0" />
              <div className="space-y-2 text-sm text-foreground">
                <p>Rozumím, že teď nechceš nebo nemůžeš nikam volat.</p>
                <p>Existuje ještě jedna možnost – jen pokud bys o ni stál/a.</p>
                <p>Můžeš se sám/sama spojit přímo s terapeutkou a napsat jí krátkou zprávu. Nemusíš vysvětlovat všechno. Stačí pár vět.</p>
                <p>Aby věděla, že jde o akutní situaci z tohoto prostoru, použiješ při kontaktu <strong>kód 11</strong>.</p>
                <p className="text-muted-foreground">Ten kód neznamená diagnózu. Znamená: <em>„Bylo mi hodně těžko a krátká pomoc nestačila."</em></p>
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <a href="mailto:mujosobniasistentnamiru@gmail.com?subject=K%C3%B3d%2011%20%E2%80%93%20pros%C3%ADm%20o%20kontakt" className="inline-flex w-full">
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full border-primary/30 text-primary hover:bg-primary/10"
                  onClick={() => {
                    setTherapistBridgeAccepted(true);
                    setTherapistBridgeMethod("email");
                    console.log("THERAPIST_BRIDGE_ACCEPTED", { scenario, riskScore, method: "email" });
                  }}
                >
                  <HeartHandshake className="w-4 h-4 mr-2" />
                  Napsat e-mail terapeutce (kód 11)
                </Button>
              </a>
              <a href="sms:+420773641106?body=K%C3%B3d%2011%20%E2%80%93%20pros%C3%ADm%20o%20kontakt" className="inline-flex w-full">
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full border-primary/30 text-primary hover:bg-primary/10"
                  onClick={() => {
                    setTherapistBridgeAccepted(true);
                    setTherapistBridgeMethod("sms");
                    console.log("THERAPIST_BRIDGE_ACCEPTED", { scenario, riskScore, method: "sms" });
                  }}
                >
                  <Phone className="w-4 h-4 mr-2" />
                  Poslat SMS terapeutce (kód 11)
                </Button>
              </a>
            </div>
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              Kontakt je dobrovolný. Terapeutka nemůže garantovat okamžitou odpověď, ale kód 11 znamená, že se na zprávu podívá co nejdříve.
            </p>
          </div>
        </div>
      )}

      {/* Therapist bridge – accepted confirmation */}
      {therapistBridgeAccepted && (
        <div className="border-t border-primary/20 bg-primary/5 px-4 py-3">
          <div className="max-w-2xl mx-auto">
            <div className="flex items-center gap-2">
              <HeartHandshake className="w-4 h-4 text-primary" />
              <p className="text-sm text-foreground">
                Při kontaktu s terapeutkou uveď <strong>kód 11</strong>. Nemusíš vysvětlovat víc, než chceš.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Risk help banner – ELEVATED risk */}
      {riskLevel === "elevated" && (
        <div className="border-t border-amber-500/30 bg-amber-500/5 px-4 py-3">
          <div className="max-w-2xl mx-auto">
            <p className="text-sm text-foreground">
              Kdyby ses potřeboval/a s někým promluvit:{" "}
              <a href="tel:116123" className="text-primary underline font-medium">Krizová linka 116 123</a>
              {" "}(non-stop, zdarma)
            </p>
          </div>
        </div>
      )}

      {/* Input */}
      <div className="border-t border-border bg-card/50 backdrop-blur-sm">
        <div className="max-w-2xl mx-auto px-4 py-4">
          <div className="flex gap-3 items-end">
            <Textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Napiš, co cítíš..."
              className="min-h-[48px] max-h-[120px] resize-none text-sm"
              disabled={isLoading}
            />
            <Button
              onClick={sendMessage}
              disabled={!input.trim() || isLoading}
              size="icon"
              className="h-[48px] w-[48px] shrink-0"
            >
              {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            </Button>
          </div>
          <div className="flex justify-between items-center mt-2">
            <p className="text-xs text-muted-foreground">
              Nic se neukládá. Vše zůstává jen tady a teď.
            </p>
            <Button variant="ghost" size="sm" className="text-xs text-muted-foreground" onClick={onEnd}>
              Ukončit
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default CalmChat;
