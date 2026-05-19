/**
 * AdminFix84 — jednorázový admin panel pro Test A (FIX 8.4 bootstrap idempotence).
 * Volá POST /karel-hana-drive-bootstrap s aktuálním user JWT a zobrazuje surový JSON
 * pro copy-paste do chatu. Žádná další logika.
 */
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";

interface CallResult {
  index: number;
  timestamp: string;
  status: number | string;
  body: string;
}

export default function AdminFix84() {
  const [results, setResults] = useState<CallResult[]>([]);
  const [loading, setLoading] = useState(false);

  const runBootstrap = async () => {
    setLoading(true);
    const idx = results.length + 1;
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        setResults((p) => [...p, {
          index: idx,
          timestamp: new Date().toISOString(),
          status: "NO_SESSION",
          body: "Není aktivní Supabase session. Přihlas se nejdřív.",
        }]);
        setLoading(false);
        return;
      }
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-hana-drive-bootstrap`;
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          "Content-Type": "application/json",
        },
        body: "{}",
      });
      const text = await resp.text();
      let pretty = text;
      try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch { /* keep raw */ }
      setResults((p) => [...p, {
        index: idx,
        timestamp: new Date().toISOString(),
        status: resp.status,
        body: pretty,
      }]);
    } catch (e: any) {
      setResults((p) => [...p, {
        index: idx,
        timestamp: new Date().toISOString(),
        status: "FETCH_ERROR",
        body: String(e?.message || e),
      }]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ padding: 24, fontFamily: "system-ui, sans-serif", maxWidth: 900, margin: "0 auto" }}>
      <h1 style={{ fontSize: 20, marginBottom: 16 }}>FIX 8.4 — Drive bootstrap (Test A)</h1>
      <p style={{ fontSize: 13, color: "#555", marginBottom: 16 }}>
        Klikni 2× za sebou. Oba JSONy zkopíruj a pošli do chatu.
      </p>
      <button
        onClick={runBootstrap}
        disabled={loading}
        style={{
          padding: "10px 16px",
          background: loading ? "#999" : "#1f6feb",
          color: "white",
          border: "none",
          borderRadius: 6,
          cursor: loading ? "wait" : "pointer",
          fontSize: 14,
        }}
      >
        {loading ? "Volám bootstrap…" : "Spustit Drive bootstrap (FIX 8.4)"}
      </button>

      <div style={{ marginTop: 24 }}>
        {results.map((r) => (
          <div key={r.index} style={{ marginBottom: 20, border: "1px solid #ddd", borderRadius: 6, padding: 12 }}>
            <div style={{ fontSize: 13, marginBottom: 8, color: "#333" }}>
              <strong>{r.index}. volání</strong> — {r.timestamp} — HTTP <strong>{r.status}</strong>
            </div>
            <pre
              style={{
                background: "#0d1117",
                color: "#e6edf3",
                padding: 12,
                borderRadius: 4,
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                fontSize: 12,
                overflow: "auto",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                margin: 0,
              }}
            >
              {r.body}
            </pre>
          </div>
        ))}
      </div>
    </div>
  );
}
