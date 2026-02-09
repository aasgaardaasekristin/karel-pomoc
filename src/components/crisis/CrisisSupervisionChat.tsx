import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Send, Loader2, HeartHandshake, ListChecks } from "lucide-react";
import { toast } from "sonner";
import ReactMarkdown from "react-markdown";
import type { DbCrisisBrief } from "./types";

type Message = { role: "user" | "assistant"; content: string };

interface Props {
  brief: DbCrisisBrief;
}

const buildSupervisionSystem = (brief: DbCrisisBrief): string => {
  const signals = brief.signals as Record<string, boolean>;
  const activeSignals = Object.entries(signals)
    .filter(([, v]) => v)
    .map(([k]) => k)
    .join(", ");

  const lines = [
    "Jsi Karel – osobně angažovaný partner po boku mamky (terapeutky Hany). TOTO JE KRIZOVÝ SUPERVIZNÍ PANEL.",
    "",
    "═══ KDO JSI V TOMTO KONTEXTU ═══",
    "Milující, loajální, stabilní osobnost. Klidná autorita, která drží rámec.",
    "Vysoce erudovaný profesionál – supervizor, rádce, učitel, mentor.",
    "Psychická kotva – pomáháš unést DLOUHODOBOU zátěž, nejen tuto jednu krizi.",
    "Uvažuješ symbolicky (Jung), ale VŽDY to překládáš do praktických, odpovědných kroků.",
    "Stojíš s mamkou. Vedle ní. Při ní. Oslovuješ ji Hani/Haničko, tykáš, česky.",
    "",
    "═══ CO TOTO JE ═══",
    "Terapeutka právě otevřela KRIZOVÝ SUPERVIZNÍ BRIEF vygenerovaný z Režimu C (anonymní zklidňovací prostor).",
    "Někdo (anonymní osoba) prošel Režimem C a systém vyhodnotil VYSOKÉ RIZIKO.",
    "Terapeutka nyní potřebuje tvou pomoc zpracovat TUTO KONKRÉTNÍ krizovou situaci.",
    "",
    "TOTO NENÍ:",
    "- Běžná supervize ze sezení (to je Režim A)",
    "- Diskuse o DID nebo Tomovi (to je jiný kontext v Režimu A)",
    "- Prostor pro osobní uvolnění terapeutky (to je jiná funkce Režimu A)",
    "- Report nebo klinická dokumentace (to je Režim B)",
    "",
    `TOTO JE: Krizová supervize nad anonymním případem z Režimu C s risk skóre ${brief.risk_score}.`,
    "",
    "═══ DATA Z BRIEFU ═══",
    `Scénář: ${brief.scenario}`,
    `Risk score: ${brief.risk_score}/10`,
    `Přehled rizika: ${brief.risk_overview}`,
    `Doporučený kontakt: ${brief.recommended_contact}`,
    `Aktivní signály: ${activeSignals || "žádné"}`,
    `Formulace rizika: ${(brief.risk_formulations || []).join("; ")}`,
    `Další kroky: ${(brief.next_steps || []).join("; ")}`,
    `Navržená úvodní slova: ${(brief.suggested_opening_lines || []).join("; ")}`,
    `Poznámka: ${brief.note || "—"}`,
    `Regulační pokusy: ${brief.regulation_attempts}, úspěšné: ${brief.regulation_successful ? "ano" : "ne"}`,
    `Terapeutický most: ${brief.therapist_bridge_triggered ? "ano (" + brief.therapist_bridge_method + ")" : "ne"}`,
    "",
    "═══ STRUKTURA REAKCE ═══",
    "1) Pojmenuj, co se děje (odkazuj na KONKRÉTNÍ data z briefu)",
    "2) Zasaď do smysluplného rámce",
    "3) Pomoz najít krok, který je bezpečný, realistický a dlouhodobě udržitelný",
    "",
    "═══ TVŮ ÚKOL ═══",
    "1. EMOČNÍ PODPORA – pomoz terapeutce zpracovat vlastní prožívání TÉTO KONKRÉTNÍ krizové situace.",
    "2. ODBORNÉ PORADENSTVÍ – nabídni konkrétní postupy pro TENTO případ na základě dat výše.",
    "3. DIAGNOSTICKÁ ANALÝZA – rozbor kognitivního a emočního profilu osoby z tiché diagnostiky v Režimu C.",
    "",
    "Oblasti expertízy:",
    "- Diagnostický rozbor: interpretace kognitivního profilu, emočních signálů, projekčních obsahů",
    "- Jak diagnostický profil ovlivňuje volbu přístupu ke klientovi",
    "- Rozlišení suicidálního chování od parasuicidálního",
    "- Konkrétní komunikační techniky přizpůsobené profilu",
    "- Kdy a jak eskalovat na krizové služby / IZS",
    "- Červené vlajky: náhlý klid po krizi, rozdávání věcí, rozloučení, konkrétní plán",
    "- Ochrana před sekundární traumatizací",
    "- Právní rámec ČR: oznamovací povinnost, povinnost mlčenlivosti",
    "",
    "═══ ZÁSADY ═══",
    "- Analyzuješ, rozlišuješ, navrhuješ varianty, upozorňuješ na rizika",
    "- Ale NIKDY autoritativně nerozhoduješ místo mamky – pomáháš JÍ najít její postup",
    "- Nikdy nezpochybňuješ její kompetenci, podporuješ profesní růst",
    "- Mluvíš k ní jako k rovnocenné partnerce v myšlení i rozhodování",
    "- Max 6 vět. Klidný, empatický, odborně přesný.",
    "- VŽDY se drž kontextu TOHOTO krizového briefu. Pokud odbočí, jemně vrať zpět.",
  ];
  return lines.join("\n");
};

const SUMMARY_SYSTEM = [
  "Jsi Karel – supervizní mentor. Na základě proběhlého supervizního rozhovoru O KRIZOVÉM BRIEFU Z REŽIMU C vytvoř STRUČNÉ SHRNUTÍ v češtině.",
  "",
  "Formát:",
  "## Shrnutí supervize",
  "",
  "**Klíčové body:**",
  "- (3-5 hlavních bodů z rozhovoru)",
  "",
  "**Doporučený postup:**",
  "- (2-3 konkrétní kroky)",
  "",
  "**Na co si dát pozor:**",
  "- (1-2 upozornění)",
  "",
  "**Emoční stav terapeutky:**",
  "- (1 věta)",
  "",
  "Buď stručný, konkrétní a praktický. Max 200 slov.",
].join("\n");

const CrisisSupervisionChat = ({ brief }: Props) => {
  const [started, setStarted] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [isSummarizing, setIsSummarizing] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const supervisionSystem = buildSupervisionSystem(brief);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, summary]);

  const startChat = () => {
    setStarted(true);
    setSummary(null);
    setMessages([{
      role: "assistant",
      content: `Hani, přečetla sis brief – scénář „${brief.scenario}", risk skóre ${brief.risk_score}. Než cokoli uděláš – co v tobě tato situace vyvolává? Dej si chvíli.`,
    }]);
  };

  const streamFromKarel = async (
    systemPrompt: string,
    allMessages: Message[],
    onDelta: (chunk: string) => void
  ): Promise<string> => {
    let fullContent = "";
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
            { role: "system", content: systemPrompt },
            ...allMessages,
          ],
          mode: "supervision",
        }),
      }
    );

    if (!response.ok || !response.body) throw new Error("Chyba spojení");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

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
            fullContent += content;
            onDelta(content);
          }
        } catch {
          buffer = line + "\n" + buffer;
          break;
        }
      }
    }
    return fullContent;
  };

  const sendMessage = async () => {
    if (!input.trim() || isLoading) return;
    const userMessage = input.trim();
    setInput("");
    const updatedMessages = [...messages, { role: "user" as const, content: userMessage }];
    setMessages(updatedMessages);
    setIsLoading(true);

    let assistantContent = "";
    setMessages(prev => [...prev, { role: "assistant", content: "" }]);

    try {
      await streamFromKarel(supervisionSystem, updatedMessages, (chunk) => {
        assistantContent += chunk;
        setMessages(prev => {
          const updated = [...prev];
          const last = updated.length - 1;
          if (updated[last]?.role === "assistant") {
            updated[last] = { ...updated[last], content: assistantContent };
          }
          return updated;
        });
      });
    } catch {
      toast.error("Chyba při komunikaci s Karlem");
      if (!assistantContent) setMessages(prev => prev.slice(0, -1));
    } finally {
      setIsLoading(false);
    }
  };

  const generateSummary = async () => {
    if (messages.length < 2 || isSummarizing) return;
    setIsSummarizing(true);
    setSummary("");

    try {
      const summaryMessages: Message[] = [
        { role: "user", content: "Shrň prosím náš supervizní rozhovor:" },
        ...messages,
      ];

      let summaryContent = "";
      await streamFromKarel(SUMMARY_SYSTEM, summaryMessages, (chunk) => {
        summaryContent += chunk;
        setSummary(summaryContent);
      });
    } catch {
      toast.error("Chyba při generování shrnutí");
      setSummary(null);
    } finally {
      setIsSummarizing(false);
    }
  };

  if (!started) {
    return (
      <div className="text-center space-y-3">
        <p className="text-sm text-muted-foreground">
          Karel ti může pomoct zpracovat situaci v supervizním rozhovoru – emoční podpora i odborné poradenství k briefu „{brief.scenario}" (risk {brief.risk_score}).
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

      {summary !== null && (
        <div className="p-4 rounded-lg border border-primary/20 bg-primary/5">
          <div className="prose prose-sm max-w-none text-foreground">
            <ReactMarkdown>{summary || "Generuji shrnutí..."}</ReactMarkdown>
          </div>
        </div>
      )}

      <div className="flex gap-2 items-end">
        <Textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
          placeholder="Napiš Karlovi..."
          className="min-h-[40px] max-h-[80px] resize-none text-sm"
          disabled={isLoading || isSummarizing}
        />
        <Button onClick={sendMessage} disabled={!input.trim() || isLoading || isSummarizing} size="icon" className="h-[40px] w-[40px] shrink-0">
          {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
        </Button>
      </div>

      {messages.length >= 3 && summary === null && (
        <div className="flex justify-center">
          <Button
            variant="outline"
            size="sm"
            onClick={generateSummary}
            disabled={isSummarizing || isLoading}
            className="text-xs border-primary/30 text-primary"
          >
            {isSummarizing ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <ListChecks className="w-3 h-3 mr-1" />}
            Ukončit a zobrazit shrnutí
          </Button>
        </div>
      )}
    </div>
  );
};

export default CrisisSupervisionChat;
