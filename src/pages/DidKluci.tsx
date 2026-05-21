// FIX 9.K.1b — page /did/kluci
import React, { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import ChildThreadView from "@/components/did/ChildThreadView";
import ChildThreadSwitcher, { OpenThread } from "@/components/did/ChildThreadSwitcher";

const BG = "#1E1B2E";
const PARCH = "#F4E9C8";
const ACCENT = "#E8C547";

type ThreadMeta = {
  thread_id: string;
  child_part_id: string;
  child_part_name: string;
  thread_date: string;
  is_new_thread: boolean;
};

const DidKluci: React.FC = () => {
  const [openThreads, setOpenThreads] = useState<OpenThread[]>([]);
  const [current, setCurrent] = useState<ThreadMeta | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchOpen = useCallback(async () => {
    try {
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-child-thread-list-open`;
      const r = await fetch(url, {
        headers: { "apikey": import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY },
      });
      const j = await r.json();
      const t: OpenThread[] = j?.threads ?? [];
      setOpenThreads(t);
      if (!current && t.length > 0) {
        const first = t[0];
        setCurrent({
          thread_id: first.id, child_part_id: first.child_part_id,
          child_part_name: first.child_part_name,
          thread_date: new Date().toISOString().slice(0, 10),
          is_new_thread: false,
        });
      }
    } catch (e) {
      console.error("[DidKluci] list-open failed", e);
    } finally {
      setLoading(false);
    }
  }, [current]);

  useEffect(() => { fetchOpen(); }, [fetchOpen]);

  // Realtime: nová vlákna se objeví bez refresh
  useEffect(() => {
    const ch = supabase
      .channel("did-child-thread-list")
      .on("postgres_changes", {
        event: "*", schema: "public", table: "did_child_thread",
      }, () => { fetchOpen(); })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [fetchOpen]);

  function handleSelect(t: OpenThread) {
    setCurrent({
      thread_id: t.id, child_part_id: t.child_part_id,
      child_part_name: t.child_part_name,
      thread_date: new Date().toISOString().slice(0, 10),
      is_new_thread: false,
    });
  }

  function handleSwitched(newThreadId: string, newChildName: string) {
    setCurrent({
      thread_id: newThreadId, child_part_id: "",
      child_part_name: newChildName,
      thread_date: new Date().toISOString().slice(0, 10),
      is_new_thread: false,
    });
    fetchOpen();
  }

  return (
    <div style={{
      background: BG, color: PARCH, minHeight: "100vh",
      display: "flex", flexDirection: "column",
      fontFamily: "'DM Sans', system-ui, sans-serif",
    }}>
      <div style={{
        background: "#2A2440", borderBottom: `1px solid ${ACCENT}33`,
        padding: "10px 18px",
        fontFamily: "'Crimson Pro', serif", fontSize: 18, color: ACCENT,
      }}>
        DID / Kluci
      </div>

      <ChildThreadSwitcher
        current_thread_id={current?.thread_id ?? null}
        threads={openThreads}
        onSelect={handleSelect}
      />

      <div style={{ flex: 1, minHeight: 0 }}>
        {loading ? (
          <div style={{ padding: 24, color: "#9A8FB0" }}>Načítám…</div>
        ) : current ? (
          <ChildThreadView
            thread_id={current.thread_id}
            child_part_id={current.child_part_id}
            child_part_name={current.child_part_name}
            is_new_thread={current.is_new_thread}
            thread_date={current.thread_date}
            onSwitched={handleSwitched}
          />
        ) : (
          <EmptyState onMessage={handleSwitched} />
        )}
      </div>
    </div>
  );
};

const EmptyState: React.FC<{ onMessage: (id: string, name: string) => void }> = ({ onMessage }) => {
  const [txt, setTxt] = useState("");
  const [busy, setBusy] = useState(false);
  async function go() {
    const raw = txt.trim();
    if (!raw || busy) return;
    setBusy(true);
    try {
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-child-thread-send`;
      const r = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
        },
        body: JSON.stringify({ raw_text: raw, sub_mode: "cast" }),
      });
      const j = await r.json();
      if (j?.thread_id) onMessage(j.thread_id, j.child_part_name);
    } finally { setBusy(false); setTxt(""); }
  }
  return (
    <div style={{ padding: 36, color: "#F4E9C8" }}>
      <div style={{ fontFamily: "'Crimson Pro', serif", fontSize: 22, marginBottom: 12 }}>
        Napiš mi. Karel poslouchá.
      </div>
      <div style={{ display: "flex", gap: 10, maxWidth: 560 }}>
        <input
          value={txt} onChange={(e) => setTxt(e.target.value)}
          placeholder='např. "ahoj tady tundrupek"'
          style={{
            flex: 1, background: "#1A1726", color: PARCH,
            border: `1px solid ${ACCENT}33`, borderRadius: 8, padding: "10px 12px", outline: "none",
          }}
        />
        <button onClick={go} disabled={busy || !txt.trim()} style={{
          background: ACCENT, color: BG, border: "none",
          padding: "10px 18px", borderRadius: 8, fontWeight: 600,
          opacity: busy || !txt.trim() ? 0.6 : 1, cursor: "pointer",
        }}>Poslat</button>
      </div>
    </div>
  );
};

export default DidKluci;
