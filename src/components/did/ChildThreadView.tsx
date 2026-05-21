// FIX 9.K.1b — ChildThreadView
// Bradavický noční hrad. Načte historii (GET), posílá zprávy (POST send),
// subscribe Realtime na did_child_thread_message WHERE thread_id.
import React, { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import MessageBubble from "./MessageBubble";

type Msg = { id: string; sender: "child" | "karel" | "system"; content: string; sent_at: string };

export type ChildThreadViewProps = {
  thread_id: string;
  child_part_id: string;
  child_part_name: string;
  is_new_thread: boolean;
  thread_date: string;
  onSwitched?: (newThreadId: string, newChildName: string) => void;
};

const BG = "#1E1B2E";
const PARCH = "#F4E9C8";
const ACCENT = "#E8C547";
const MUTED = "#9A8FB0";
const PANEL = "#2A2440";

const ChildThreadView: React.FC<ChildThreadViewProps> = ({
  thread_id, child_part_id, child_part_name, is_new_thread, thread_date, onSwitched,
}) => {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [switchNote, setSwitchNote] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  // 1) initial load
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data, error } = await supabase.functions.invoke("karel-child-thread-messages", {
          body: undefined,
          method: "GET" as any,
          // supabase-js doesn't pass query; build URL via fetch fallback
        } as any);
        // Fallback: direct fetch (functions.invoke nepředává query stringu spolehlivě)
        if (error || !data) {
          const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-child-thread-messages?thread_id=${thread_id}`;
          const r = await fetch(url, {
            headers: { "apikey": import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY },
          });
          const j = await r.json();
          if (!cancelled && Array.isArray(j?.messages)) setMessages(j.messages);
        } else if (!cancelled && Array.isArray((data as any)?.messages)) {
          setMessages((data as any).messages);
        }
      } catch (e) {
        console.error("[ChildThreadView] load failed", e);
      }
    })();
    return () => { cancelled = true; };
  }, [thread_id]);

  // 2) Realtime subscription
  useEffect(() => {
    const channel = supabase
      .channel(`did-child-thread-${thread_id}`)
      .on("postgres_changes", {
        event: "INSERT",
        schema: "public",
        table: "did_child_thread_message",
        filter: `thread_id=eq.${thread_id}`,
      }, (payload) => {
        const m = payload.new as any;
        setMessages(prev => prev.some(x => x.id === m.id) ? prev : [...prev, {
          id: m.id, sender: m.sender, content: m.content, sent_at: m.sent_at,
        }]);
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [thread_id]);

  // 3) auto-scroll
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function send() {
    const txt = input.trim();
    if (!txt || busy) return;
    setBusy(true);
    setThinking(true);
    const optimistic: Msg = {
      id: `optim-${Date.now()}`, sender: "child", content: txt, sent_at: new Date().toISOString(),
    };
    setMessages(prev => [...prev, optimistic]);
    setInput("");

    try {
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-child-thread-send`;
      const r = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
        },
        body: JSON.stringify({ thread_id, raw_text: txt, sub_mode: "cast" }),
      });
      const j = await r.json();
      if (j?.thread_id && j.thread_id !== thread_id) {
        setSwitchNote(`Přepínám na ${j.child_part_name}ovo vlákno.`);
        setTimeout(() => setSwitchNote(null), 3000);
        onSwitched?.(j.thread_id, j.child_part_name);
      }
    } catch (e) {
      console.error("[ChildThreadView] send failed", e);
    } finally {
      setBusy(false);
      setThinking(false);
    }
  }

  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <div style={{
      background: BG, color: PARCH, height: "100%", display: "flex", flexDirection: "column",
      fontFamily: "'DM Sans', system-ui, sans-serif",
    }}>
      {/* Header (sticky) */}
      <div style={{
        position: "sticky", top: 0, zIndex: 2, background: PANEL,
        borderBottom: `1px solid ${ACCENT}33`, padding: "12px 18px",
        display: "flex", alignItems: "center", gap: 14,
      }}>
        <div style={{
          width: 44, height: 44, borderRadius: 22, background: BG,
          color: ACCENT, border: `2px solid ${ACCENT}`,
          display: "flex", alignItems: "center", justifyContent: "center",
          fontFamily: "'Crimson Pro', serif", fontSize: 22, fontWeight: 700,
        }}>
          {(child_part_name || "?").charAt(0).toUpperCase()}
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: "'Crimson Pro', serif", fontSize: 22, color: PARCH }}>
            {child_part_name || "vlákno"}
          </div>
          <div style={{ fontSize: 12, color: MUTED }}>
            Tady jsi v bezpečí. Karel poslouchá. · {thread_date}
          </div>
        </div>
        {thinking && (
          <div style={{ fontSize: 12, color: ACCENT, fontStyle: "italic" }}>
            Karel přemýšlí…
          </div>
        )}
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflowY: "auto", padding: "16px 18px" }}>
        {is_new_thread && messages.length === 0 && (
          <div style={{ color: MUTED, textAlign: "center", marginTop: 24, fontStyle: "italic" }}>
            Nové vlákno. Napiš mi.
          </div>
        )}
        {messages.map((m) => (
          <MessageBubble
            key={m.id} sender={m.sender} content={m.content} sent_at={m.sent_at}
          />
        ))}
        {switchNote && (
          <div style={{ textAlign: "center", color: MUTED, fontStyle: "italic", fontSize: 12, marginTop: 8 }}>
            {switchNote}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input (sticky bottom) */}
      <div style={{
        position: "sticky", bottom: 0, background: PANEL,
        borderTop: `1px solid ${ACCENT}33`, padding: "10px 14px",
      }}>
        <div style={{ display: "flex", gap: 10, alignItems: "flex-end" }}>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKey}
            placeholder="Napiš mi…"
            rows={2}
            style={{
              flex: 1, resize: "none",
              background: "#1A1726", color: PARCH,
              border: `1px solid ${ACCENT}33`, borderRadius: 8,
              padding: "8px 10px", fontFamily: "'DM Sans', system-ui, sans-serif", fontSize: 15,
              outline: "none",
            }}
            disabled={busy}
          />
          <button
            onClick={send}
            disabled={busy || !input.trim()}
            style={{
              background: ACCENT, color: "#1E1B2E", border: "none",
              padding: "10px 18px", borderRadius: 8, cursor: busy ? "default" : "pointer",
              fontWeight: 600, opacity: busy || !input.trim() ? 0.6 : 1,
              fontFamily: "'DM Sans', system-ui, sans-serif",
            }}
          >Poslat</button>
        </div>
        <div style={{ fontSize: 11, color: MUTED, marginTop: 6 }}>
          Karlovi můžeš psát kdykoli. Vrátí se k tobě.
        </div>
      </div>
    </div>
  );
};

export default ChildThreadView;
