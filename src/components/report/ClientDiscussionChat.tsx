import { useState, useRef, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Loader2, Send, MessageSquare, Save, Check } from "lucide-react";
import { getAuthHeaders } from "@/lib/auth";
import { supabase } from "@/integrations/supabase/client";
import ReactMarkdown from "react-markdown";
import { toast } from "sonner";

type Message = { role: "user" | "assistant"; content: string };

interface ClientDiscussionChatProps {
  clientId: string;
  clientName: string;
}

const ClientDiscussionChat = ({ clientId, clientName }: ClientDiscussionChatProps) => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [initialLoaded, setInitialLoaded] = useState(false);
  const [saved, setSaved] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const scrollToBottom = useCallback(() => {
    setTimeout(() => {
      scrollRef.current?.scrollIntoView({ behavior: "smooth" });
    }, 50);
  }, []);

  // Load initial analysis
  useEffect(() => {
    if (initialLoaded) return;
    const loadInitial = async () => {
      setIsLoading(true);
      try {
        const headers = await getAuthHeaders();
        const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-supervision-discuss`, {
          method: "POST",
          headers,
          body: JSON.stringify({ clientId, clientName }),
        });
        if (!res.ok) throw new Error("Chyba při načítání");
        const data = await res.json();
        if (data.response) {
          setMessages([{ role: "assistant", content: data.response }]);
        }
      } catch (e: any) {
        toast.error("Nepodařilo se načíst analýzu klienta");
      } finally {
        setIsLoading(false);
        setInitialLoaded(true);
      }
    };
    loadInitial();
  }, [clientId, clientName, initialLoaded]);

  useEffect(() => { scrollToBottom(); }, [messages, scrollToBottom]);

  const sendMessage = async () => {
    const text = input.trim();
    if (!text || isLoading) return;

    const userMsg: Message = { role: "user", content: text };
    const updatedMessages = [...messages, userMsg];
    setMessages(updatedMessages);
    setInput("");
    setIsLoading(true);

    try {
      const headers = await getAuthHeaders();
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-supervision-discuss`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          clientId,
          clientName,
          messages: updatedMessages,
          mode: "chat",
        }),
      });

      if (!res.ok || !res.body) throw new Error("Stream error");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let assistantContent = "";

      setMessages(prev => [...prev, { role: "assistant", content: "" }]);

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
              assistantContent += delta;
              setMessages(prev => {
                const copy = [...prev];
                copy[copy.length - 1] = { role: "assistant", content: assistantContent };
                return copy;
              });
            }
          } catch { /* partial chunk */ }
        }
      }
    } catch (e: any) {
      toast.error("Chyba při komunikaci s Karlem");
      console.error(e);
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  return (
    <div className="flex flex-col h-[calc(100vh-200px)] bg-card rounded-xl border border-border overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-border bg-card/50">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <MessageSquare className="w-4 h-4 text-primary" />
            <span className="text-sm font-medium">Porada o klientovi: {clientName}</span>
          </div>
          {messages.length > 0 && !isLoading && (
            <Button
              variant="outline"
              size="sm"
              disabled={saved}
              className="gap-1.5 h-8 text-xs"
              onClick={async () => {
                try {
                  const fullTranscript = messages.map(m =>
                    `${m.role === "user" ? "TERAPEUT" : "KAREL"}: ${m.content}`
                  ).join("\n\n");
                  const { error } = await supabase.from("client_sessions").insert({
                    client_id: clientId,
                    notes: "Supervizní konzultace s Karlem",
                    ai_analysis: fullTranscript,
                  });
                  if (error) throw error;
                  setSaved(true);
                  toast.success("Konzultace uložena do kartotéky");
                } catch (e: any) {
                  toast.error("Nepodařilo se uložit konzultaci");
                  console.error(e);
                }
              }}
            >
              {saved ? <Check className="w-3.5 h-3.5" /> : <Save className="w-3.5 h-3.5" />}
              {saved ? "Uloženo" : "Uložit"}
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground mt-0.5">Karel analyzoval kartu klienta a historii sezení</p>
      </div>

      {/* Messages */}
      <ScrollArea className="flex-1 px-4 py-3">
        <div className="space-y-4 max-w-2xl mx-auto">
          {messages.length === 0 && isLoading && (
            <div className="flex flex-col items-center gap-3 py-8">
              <Loader2 className="w-6 h-6 animate-spin text-primary" />
              <span className="text-sm text-muted-foreground">Karel studuje kartu klienta…</span>
              <div className="w-48 h-1.5 bg-secondary rounded-full overflow-hidden">
                <div className="h-full bg-primary rounded-full animate-indeterminate-progress" style={{ width: "40%" }} />
              </div>
              <span className="text-xs text-muted-foreground">Může to trvat 10–20 sekund</span>
            </div>
          )}
          {messages.map((msg, i) => (
            <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
              <div className={`max-w-[85%] rounded-xl px-4 py-3 text-sm ${
                msg.role === "user"
                  ? "bg-primary text-primary-foreground"
                  : "bg-secondary/50 text-foreground"
              }`}>
                {msg.role === "assistant" ? (
                  <div className="prose prose-sm dark:prose-invert max-w-none [&>p]:my-1 [&>ul]:my-1 [&>ol]:my-1">
                    <ReactMarkdown>{msg.content || "…"}</ReactMarkdown>
                  </div>
                ) : (
                  <p className="whitespace-pre-wrap">{msg.content}</p>
                )}
              </div>
            </div>
          ))}
          <div ref={scrollRef} />
        </div>
      </ScrollArea>

      {/* Input */}
      <div className="px-4 py-3 border-t border-border bg-card/50">
        <div className="flex gap-2 max-w-2xl mx-auto">
          <Textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Zeptej se Karla na cokoliv o tomto klientovi…"
            className="min-h-[44px] max-h-[120px] resize-none text-sm"
            rows={1}
          />
          <Button
            size="icon"
            onClick={sendMessage}
            disabled={!input.trim() || isLoading}
            className="h-11 w-11 shrink-0"
          >
            {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </Button>
        </div>
      </div>
    </div>
  );
};

export default ClientDiscussionChat;
