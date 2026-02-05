import { useState, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Send, LogOut, Loader2 } from "lucide-react";
import { toast } from "sonner";
import ReactMarkdown from "react-markdown";
import ModeSelector from "@/components/ModeSelector";
import ChatMessage from "@/components/ChatMessage";

type Message = {
  role: "user" | "assistant";
  content: string;
};

type ConversationMode = "debrief" | "supervision" | "safety" | "childcare";

const Chat = () => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [mode, setMode] = useState<ConversationMode>("debrief");
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const navigate = useNavigate();

  // Check authentication
  useEffect(() => {
    const isAuthenticated = sessionStorage.getItem("authenticated");
    if (!isAuthenticated) {
      navigate("/");
    }
  }, [navigate]);

  // Auto-scroll to bottom
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  // Welcome message when mode changes
  useEffect(() => {
    const welcomeMessages: Record<ConversationMode, string> = {
      debrief: "Hani, jsem tady. Pojď, sedni si ke mně k ohni. Pracovní den končí a já ti držím prostor, abys mohla odložit vše, co v tobě zůstalo. Jak se právě teď cítíš?",
      supervision: "Haničko, jsem připraven s tebou pracovat. Která postava z tvé praxe tě teď zaměstnává? Můžeme reflektovat, trénovat, nebo ti nabídnu strukturovaný zápis - co potřebuješ?",
      safety: "Hani, pojďme společně a věcně projít to, co tě znepokojuje. Jsem tu jako tvůj partner - projdeme hranice, postup i dokumentaci. Na čem pracujeme?",
      childcare: "Haničko, jsem tady s tebou. Vím, jak náročná je péče o tvé dítě s DID. Pojďme spolu projít, co se děje - ať už potřebuješ porozumět nějakému alteru, zpracovat náročnou situaci, nebo jen sdílet. Co teď nejvíc potřebuješ?",
    };

    setMessages([{ role: "assistant", content: welcomeMessages[mode] }]);
  }, [mode]);

  const handleLogout = () => {
    sessionStorage.removeItem("authenticated");
    navigate("/");
  };

  const sendMessage = async () => {
    if (!input.trim() || isLoading) return;

    const userMessage = input.trim();
    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: userMessage }]);
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
            messages: [...messages, { role: "user", content: userMessage }],
            mode,
          }),
        }
      );

      if (!response.ok) {
        if (response.status === 429) {
          throw new Error("Příliš mnoho požadavků. Počkej chvíli a zkus to znovu.");
        }
        if (response.status === 402) {
          throw new Error("Vyčerpány kredity. Kontaktuj správce.");
        }
        throw new Error("Něco se pokazilo. Zkus to znovu.");
      }

      if (!response.body) throw new Error("Žádná odpověď");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      // Add empty assistant message to start streaming into
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
              setMessages((prev) => {
                const newMessages = [...prev];
                const lastIndex = newMessages.length - 1;
                if (newMessages[lastIndex]?.role === "assistant") {
                  newMessages[lastIndex] = {
                    ...newMessages[lastIndex],
                    content: assistantContent,
                  };
                }
                return newMessages;
              });
            }
          } catch {
            buffer = line + "\n" + buffer;
            break;
          }
        }
      }
    } catch (error) {
      console.error("Chat error:", error);
      toast.error(error instanceof Error ? error.message : "Chyba při komunikaci");
      // Remove the empty assistant message if error occurred
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
    <div className="min-h-screen flex flex-col bg-background">
      {/* Header */}
      <header className="border-b border-border bg-card/50 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-4 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-serif font-semibold text-foreground">Carl Gustav Jung</h1>
            <p className="text-sm text-muted-foreground">Tvůj partner a supervizní mentor</p>
          </div>
          <Button variant="ghost" size="sm" onClick={handleLogout}>
            <LogOut className="w-4 h-4 mr-2" />
            Odejít
          </Button>
        </div>
      </header>

      {/* Mode Selector */}
      <div className="border-b border-border bg-card/30">
        <div className="max-w-4xl mx-auto px-4 py-3">
          <ModeSelector currentMode={mode} onModeChange={setMode} />
        </div>
      </div>

      {/* Chat Messages */}
      <ScrollArea className="flex-1 px-4" ref={scrollRef}>
        <div className="max-w-4xl mx-auto py-6 space-y-4">
          {messages.map((message, index) => (
            <ChatMessage key={index} message={message} />
          ))}
          {isLoading && messages[messages.length - 1]?.role === "user" && (
            <div className="flex justify-start">
              <div className="chat-message-assistant flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin text-primary" />
                <span className="text-muted-foreground">Karel přemýšlí...</span>
              </div>
            </div>
          )}
        </div>
      </ScrollArea>

      {/* Input Area */}
      <div className="border-t border-border bg-card/50 backdrop-blur-sm">
        <div className="max-w-4xl mx-auto px-4 py-4">
          <div className="flex gap-3 items-end">
            <Textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Napiš svou zprávu..."
              className="min-h-[56px] max-h-[200px] resize-none"
              disabled={isLoading}
            />
            <Button
              onClick={sendMessage}
              disabled={!input.trim() || isLoading}
              size="icon"
              className="h-[56px] w-[56px] shrink-0"
            >
              {isLoading ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : (
                <Send className="w-5 h-5" />
              )}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground mt-2 text-center">
            Soukromé temenos. Žádná data se neukládají.
          </p>
        </div>
      </div>
    </div>
  );
};

export default Chat;
