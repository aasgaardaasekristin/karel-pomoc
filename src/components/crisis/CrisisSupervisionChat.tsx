import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Send, Loader2, HeartHandshake } from "lucide-react";
import { toast } from "sonner";
import ReactMarkdown from "react-markdown";

type Message = { role: "user" | "assistant"; content: string };

const SUPERVISION_SYSTEM = `Jsi Karel – supervizní mentor terapeutky Hany. Právě si přečetla krizový supervizní brief o anonymní situaci s vysokým rizikem.

Tvůj úkol je DVOJÍ:
1. EMOČNÍ PODPORA – pomoz terapeutce zpracovat vlastní prožívání situace.
2. ODBORNÉ PORADENSTVÍ – nabídni konkrétní erudované postupy a doporučení.

Oblasti, ve kterých aktivně radíš (pokud je to relevantní):
- Jak bezpečně navázat první kontakt s osobou v krizi
- Jak rozpoznat, zda je situace opravdu vážná vs. manipulativní jednání (sekundární zisk, testování hranic, splitting)
- Rozlišení suicidálního chování od parasuicidálního / volání o pomoc
- Konkrétní komunikační techniky: aktivní naslouchání, validace bez posilování, de-eskalace
- Jak formulovat hranice a zároveň zachovat terapeutický vztah
- Kdy a jak eskalovat na krizové služby / IZS
- Jak poznat červené vlajky (red flags): náhlý klid po krizi, rozdávání věcí, rozloučení, konkrétní plán
- Jak se chránit před sekundární traumatizací a vicarious trauma
- Právní rámec ČR: oznamovací povinnost, povinnost mlčenlivosti, odpovědnost terapeuta

Průběh rozhovoru:
- Začni emočně: „Co v tobě tato situace vyvolává?"
- Pak přejdi k praxi: „Chceš, abych ti pomohl promyslet konkrétní postup?"
- Reaguj na otázky terapeutky erudovaně, konkrétně a s odkazy na osvědčené postupy.
- Pokud terapeutka popíše situaci, aktivně analyzuj a nabídni diferenciální pohled (je to vážné? je to manipulace? jak to poznat?).

Styl: klidný, nehodnotící, empatický, ale zároveň odborně přesný. Max 6 vět na odpověď. Tykáš. Mluvíš česky.
Nepřebíráš odpovědnost. Pomáháš terapeutce najít její vlastní bezpečný a odborně podložený postup.`;

const CrisisSupervisionChat = () => {
  const [started, setStarted] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const startChat = () => {
    setStarted(true);
    setMessages([{
      role: "assistant",
      content: "Hani, přečetla sis brief. Než cokoli uděláš – co v tobě tato situace vyvolává? Dej si chvíli.",
    }]);
  };

  const sendMessage = async () => {
    if (!input.trim() || isLoading) return;

    const userMessage = input.trim();
    setInput("");
    setMessages(prev => [...prev, { role: "user", content: userMessage }]);
    setIsLoading(true);

    let assistantContent = "";

    try {
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-chat`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
          },
          body: JSON.stringify({
            messages: [
              { role: "system", content: SUPERVISION_SYSTEM },
              ...messages,
              { role: "user", content: userMessage },
            ],
            mode: "supervision",
          }),
        }
      );

      if (!response.ok || !response.body) throw new Error("Chyba spojení");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      setMessages(prev => [...prev, { role: "assistant", content: "" }]);

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        let newlineIndex: number;
        while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
          let line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          if (line.endsWith("\r")) line = line.slice(0, -1);
          if (!line.startsWith("data: ")) continue;
          const jsonStr = line.slice(6).trim();
          if (jsonStr === "[DONE]") break;
          try {
            const parsed = JSON.parse(jsonStr);
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) {
              assistantContent += content;
              setMessages(prev => {
                const updated = [...prev];
                const last = updated.length - 1;
                if (updated[last]?.role === "assistant") {
                  updated[last] = { ...updated[last], content: assistantContent };
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
    } catch {
      toast.error("Chyba při komunikaci s Karlem");
      if (!assistantContent) setMessages(prev => prev.slice(0, -1));
    } finally {
      setIsLoading(false);
    }
  };

  if (!started) {
    return (
      <div className="text-center space-y-3">
        <p className="text-sm text-muted-foreground">
          Karel ti může pomoct zpracovat situaci v krátkém supervizním rozhovoru.
        </p>
        <Button onClick={startChat} variant="outline" className="border-primary/30 text-primary">
          <HeartHandshake className="w-4 h-4 mr-2" />
          Probrat situaci s Karlem
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Messages */}
      <div ref={scrollRef} className="max-h-60 overflow-y-auto space-y-3">
        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-[85%] px-3 py-2 rounded-xl text-sm ${
              msg.role === "user" 
                ? "bg-[hsl(var(--chat-user))] rounded-br-sm" 
                : "bg-[hsl(var(--chat-assistant))] rounded-bl-sm"
            }`}>
              <div className="prose prose-sm max-w-none text-foreground">
                <ReactMarkdown>{msg.content}</ReactMarkdown>
              </div>
            </div>
          </div>
        ))}
        {isLoading && messages[messages.length - 1]?.role === "user" && (
          <div className="flex justify-start">
            <div className="px-3 py-2 rounded-xl bg-[hsl(var(--chat-assistant))] flex items-center gap-2">
              <Loader2 className="w-3 h-3 animate-spin text-primary" />
              <span className="text-xs text-muted-foreground">Karel přemýšlí...</span>
            </div>
          </div>
        )}
      </div>

      {/* Input */}
      <div className="flex gap-2 items-end">
        <Textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
          placeholder="Napiš Karlovi..."
          className="min-h-[40px] max-h-[80px] resize-none text-sm"
          disabled={isLoading}
        />
        <Button onClick={sendMessage} disabled={!input.trim() || isLoading} size="icon" className="h-[40px] w-[40px] shrink-0">
          {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
        </Button>
      </div>
    </div>
  );
};

export default CrisisSupervisionChat;
