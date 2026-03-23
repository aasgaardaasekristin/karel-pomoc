import { useState, useRef, useEffect } from "react";
import ThemeQuickButton from "@/components/ThemeQuickButton";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Send, Loader2, Globe, MessageSquare, GraduationCap, ArrowLeft, Trophy } from "lucide-react";
import { getAuthHeaders } from "@/lib/auth";
import { toast } from "sonner";
import ChatMessage from "@/components/ChatMessage";
import RichMarkdown from "@/components/ui/RichMarkdown";

type Message = { role: "user" | "assistant"; content: string };
type PostSessionMode = null | "research" | "discuss" | "training";

interface PostSessionToolsProps {
  clientId: string;
  clientName: string;
  sessionReport: string;
  onBack: () => void;
}

const PostSessionTools = ({ clientId, clientName, sessionReport, onBack }: PostSessionToolsProps) => {
  const [activeMode, setActiveMode] = useState<PostSessionMode>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Scroll to bottom
  useEffect(() => {
    const viewport = scrollRef.current?.querySelector("[data-radix-scroll-area-viewport]") as HTMLDivElement | null;
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
  }, [messages]);

  const startMode = async (mode: PostSessionMode) => {
    setActiveMode(mode);
    setMessages([]);
    setIsLoading(true);

    try {
      const headers = await getAuthHeaders();
      let endpoint = "";
      let body: any = { clientId, clientName, sessionReport };

      switch (mode) {
        case "research":
          endpoint = "karel-client-research";
          break;
        case "discuss":
          endpoint = "karel-supervision-discuss";
          break;
        case "training":
          endpoint = "karel-supervision-training";
          break;
      }

      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/${endpoint}`,
        { method: "POST", headers, body: JSON.stringify(body) }
      );

      if (!response.ok) throw new Error("Chyba");
      const data = await response.json();
      setMessages([{ role: "assistant", content: data.response || data.analysis || "Karel je připraven." }]);
    } catch (error) {
      console.error(`${mode} error:`, error);
      toast.error("Chyba při komunikaci s Karlem");
      // Provide fallback greeting
      const greetings: Record<string, string> = {
        research: `🔬 Hani, prohledávám internet pro nové přístupy k práci s **${clientName}**. Co konkrétně tě zajímá?`,
        discuss: `Hani, pojďme probrat případ **${clientName}**. Přečetl jsem si všechna sezení a zápisy. Co bys chtěla prodiskutovat?`,
        training: `🎯 Hani, připravil jsem simulaci klienta **${clientName}** na základě dat z kartotéky. Řekni mi, jakou situaci chceš trénovat – já budu hrát klienta a ty reaguješ. Na konci tě oboduju a dám zpětnou vazbu.`,
      };
      setMessages([{ role: "assistant", content: greetings[mode!] || "" }]);
    } finally {
      setIsLoading(false);
    }
  };

  const sendMessage = async () => {
    if (!input.trim() || isLoading || !activeMode) return;
    const userMessage = input.trim();
    setInput("");

    const updatedMessages = [...messages, { role: "user" as const, content: userMessage }];
    setMessages(updatedMessages);
    setIsLoading(true);

    let assistantContent = "";
    try {
      const headers = await getAuthHeaders();
      let endpoint = "";
      switch (activeMode) {
        case "research": endpoint = "karel-client-research"; break;
        case "discuss": endpoint = "karel-supervision-discuss"; break;
        case "training": endpoint = "karel-supervision-training"; break;
      }

      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/${endpoint}`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            clientId,
            clientName,
            sessionReport,
            messages: updatedMessages,
            mode: "chat",
          }),
        }
      );

      if (!response.ok || !response.body) throw new Error("Chyba");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      setMessages([...updatedMessages, { role: "assistant", content: "" }]);

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          let line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          if (line.endsWith("\r")) line = line.slice(0, -1);
          if (!line.startsWith("data: ")) continue;
          const json = line.slice(6).trim();
          if (json === "[DONE]") break;
          try {
            const parsed = JSON.parse(json);
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) {
              assistantContent += content;
              setMessages([...updatedMessages, { role: "assistant" as const, content: assistantContent }]);
            }
          } catch {
            buffer = line + "\n" + buffer;
            break;
          }
        }
      }
    } catch (error) {
      console.error("Post-session chat error:", error);
      toast.error("Chyba při komunikaci s Karlem");
      if (!assistantContent) setMessages(messages);
    } finally {
      setIsLoading(false);
      textareaRef.current?.focus();
    }
  };

  // Report view + tool buttons
  if (!activeMode) {
    return (
      <ScrollArea className="flex-1">
        <div className="max-w-2xl mx-auto p-4 sm:p-6 space-y-5">
          <div className="flex items-center justify-between gap-2">
            <Button variant="ghost" size="sm" onClick={onBack} className="gap-1 text-xs h-7">
              <ArrowLeft className="w-3.5 h-3.5" /> Zpět k výběru klienta
            </Button>
            <ThemeQuickButton />
          </div>

          <div className="space-y-2">
            <h2 className="text-lg font-semibold text-foreground">Zápis ze sezení – {clientName}</h2>
            <div className="bg-card border border-border rounded-lg p-4">
              <div className="prose prose-sm max-w-none text-foreground/90">
                <ReactMarkdown>{sessionReport}</ReactMarkdown>
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Nástroje po sezení</h3>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <Button
                variant="outline"
                className="h-auto py-4 flex flex-col items-center gap-2 text-center"
                onClick={() => startMode("research")}
              >
                <Globe className="w-5 h-5 text-primary" />
                <span className="text-sm font-medium">Poradit se na internetu</span>
                <span className="text-[10px] text-muted-foreground">Nové metody a přístupy</span>
              </Button>
              <Button
                variant="outline"
                className="h-auto py-4 flex flex-col items-center gap-2 text-center"
                onClick={() => startMode("discuss")}
              >
                <MessageSquare className="w-5 h-5 text-primary" />
                <span className="text-sm font-medium">Probrat situaci se mnou</span>
                <span className="text-[10px] text-muted-foreground">Supervizní pohled Karla</span>
              </Button>
              <Button
                variant="outline"
                className="h-auto py-4 flex flex-col items-center gap-2 text-center"
                onClick={() => startMode("training")}
              >
                <GraduationCap className="w-5 h-5 text-primary" />
                <span className="text-sm font-medium">Supervizní trénink</span>
                <span className="text-[10px] text-muted-foreground">Simulace klienta</span>
              </Button>
            </div>
          </div>
        </div>
      </ScrollArea>
    );
  }

  // Chat view for active mode
  const modeLabels: Record<string, string> = {
    research: "🔬 Internet rešerše",
    discuss: "💬 Supervizní diskuze",
    training: "🎯 Supervizní trénink",
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="p-2 md:p-3 border-b border-border bg-card/30 flex items-center justify-between">
        <div>
          <h3 className="text-xs md:text-sm font-semibold text-foreground">{modeLabels[activeMode]}</h3>
          <p className="text-[10px] md:text-xs text-muted-foreground">{clientName}</p>
        </div>
        <div className="flex items-center gap-2">
          <ThemeQuickButton />
          <Button variant="ghost" size="sm" onClick={() => { setActiveMode(null); setMessages([]); }} className="h-7 text-xs">
            ← Zpět k zápisu
          </Button>
        </div>
      </div>

      <ScrollArea className="flex-1" ref={scrollRef}>
        <div className="p-3 space-y-3">
          {messages.map((msg, i) => (
            <ChatMessage key={i} message={msg} />
          ))}
          {isLoading && (messages.length === 0 || messages[messages.length - 1]?.role === "user") && (
            <div className="flex justify-start">
              <div className="chat-message-assistant">
                <Loader2 className="w-4 h-4 animate-spin text-primary" />
              </div>
            </div>
          )}
        </div>
      </ScrollArea>

      <div className="p-3 border-t border-border">
        <div className="flex gap-2 items-end">
          <Textarea
            ref={textareaRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
              }
            }}
            placeholder={activeMode === "training" ? "Reaguj na klienta..." : "Napiš svou zprávu..."}
            className="flex-1 min-w-0 min-h-[40px] max-h-[100px] resize-none text-sm"
            disabled={isLoading}
          />
          <Button
            size="icon"
            onClick={sendMessage}
            disabled={!input.trim() || isLoading}
            className="h-[40px] w-[40px] shrink-0"
          >
            {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </Button>
        </div>
      </div>
    </div>
  );
};

export default PostSessionTools;
