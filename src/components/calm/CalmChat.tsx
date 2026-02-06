import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Send, Loader2, Phone } from "lucide-react";
import { toast } from "sonner";
import ReactMarkdown from "react-markdown";
import type { CalmScenario } from "./ScenarioSelector";

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
  shame: "Stud je jeden z nejtěžších pocitů. A je v pořádku, že to cítíš.\n\nChceš mi říct, co to vyvolalo?",
  other: "Jsem tady, ať je to cokoliv.\n\nPověz mi jednou větou, co se teď děje.",
};

// Webhook placeholder
const WEBHOOK_URL = null;

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
  const [showRiskHelp, setShowRiskHelp] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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
              const displayContent = assistantContent.replace(/\[RISK:HIGH\]/g, "").trim();

              // Detect risk
              if (assistantContent.includes("[RISK:HIGH]")) {
                setShowRiskHelp(true);
                console.log("HIGH_RISK_DETECTED");
                if (WEBHOOK_URL) {
                  // Future webhook call
                }
              }

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
                <div className="prose prose-sm max-w-none text-foreground">
                  <ReactMarkdown>{msg.content}</ReactMarkdown>
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

      {/* Risk help banner */}
      {showRiskHelp && (
        <div className="border-t border-destructive/30 bg-destructive/5 px-4 py-3">
          <div className="max-w-2xl mx-auto">
            <p className="text-sm text-foreground mb-2 font-medium">
              Pokud potřebuješ okamžitou pomoc:
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                className="text-xs border-destructive/30"
                onClick={() => {
                  // Placeholder - no actual action yet
                  toast.info("Tato funkce bude brzy dostupná.");
                }}
              >
                <Phone className="w-3 h-3 mr-1" />
                Linka bezpečí (116 111) – děti
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="text-xs border-destructive/30"
                onClick={() => {
                  toast.info("Tato funkce bude brzy dostupná.");
                }}
              >
                <Phone className="w-3 h-3 mr-1" />
                Krizová linka (116 123) – dospělí
              </Button>
            </div>
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
