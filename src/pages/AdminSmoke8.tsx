/**
 * AdminSmoke8 — admin panel pro Smoke Test 8 (kroky 2, 4, 5).
 * Volá karel-hana-smoke8-ops s aktuálním user JWT a zobrazuje raw JSON.
 */
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";

interface CallResult {
  index: number;
  timestamp: string;
  step: string;
  status: number | string;
  body: string;
}

export default function AdminSmoke8() {
  const [results, setResults] = useState<CallResult[]>([]);
  const [loadingStep, setLoadingStep] = useState<string | null>(null);

  const runAction = async (action: "append_marker" | "trigger_context_prime" | "verify_drive" | "drive_global_search", stepLabel: string, extraBody: Record<string, unknown> = {}) => {
    setLoadingStep(stepLabel);
    const idx = results.length + 1;
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        setResults((p) => [...p, {
          index: idx, timestamp: new Date().toISOString(), step: stepLabel,
          status: "NO_SESSION", body: "Není aktivní session. Přihlas se nejdřív.",
        }]);
        return;
      }
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-hana-smoke8-ops`;
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action }),
      });
      const text = await resp.text();
      let pretty = text;
      try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch { /* keep raw */ }
      setResults((p) => [...p, {
        index: idx, timestamp: new Date().toISOString(), step: stepLabel,
        status: resp.status, body: pretty,
      }]);
    } catch (e: any) {
      setResults((p) => [...p, {
        index: idx, timestamp: new Date().toISOString(), step: stepLabel,
        status: "FETCH_ERROR", body: String(e?.message || e),
      }]);
    } finally {
      setLoadingStep(null);
    }
  };

  const btnStyle = (disabled: boolean, color: string) => ({
    padding: "10px 16px",
    background: disabled ? "#999" : color,
    color: "white",
    border: "none",
    borderRadius: 6,
    cursor: disabled ? "wait" : "pointer",
    fontSize: 14,
    marginRight: 12,
    marginBottom: 8,
  });

  return (
    <div style={{ padding: 24, fontFamily: "system-ui, sans-serif", maxWidth: 1000, margin: "0 auto" }}>
      <h1 style={{ fontSize: 20, marginBottom: 8 }}>Smoke Test 8 — VLAKNA_POSLEDNI write-conflict (8.5)</h1>
      <p style={{ fontSize: 13, color: "#555", marginBottom: 16 }}>
        Pořadí: 2 → (Hana zpráva ručně přes prod chat) → 4 → 5. Mezi 2 a 4 počkej na zelenou.
      </p>

      <div style={{ marginBottom: 24 }}>
        <button
          onClick={() => runAction("append_marker", "Krok 2 — append SORTER_TEST_MARKER")}
          disabled={!!loadingStep}
          style={btnStyle(!!loadingStep, "#1f6feb")}
        >
          {loadingStep === "Krok 2 — append SORTER_TEST_MARKER" ? "Píšu…" : "Krok 2 — Zapsat SORTER_TEST_MARKER do VLAKNA"}
        </button>
        <div style={{ fontSize: 12, color: "#666", marginBottom: 8, fontStyle: "italic" }}>
          Krok 4 trigger posílá <code>forceRefresh: true</code> — regenerátor zapíše na Drive (test-only override).
        </div>
        <button
          onClick={() => runAction("trigger_context_prime", "Krok 4 — trigger context-prime")}
          disabled={!!loadingStep}
          style={btnStyle(!!loadingStep, "#a855f7")}
        >
          {loadingStep === "Krok 4 — trigger context-prime" ? "Triggery…" : "Krok 4 — Spustit karel-did-context-prime"}
        </button>
        <button
          onClick={() => runAction("verify_drive", "Krok 5 — Drive verify")}
          disabled={!!loadingStep}
          style={btnStyle(!!loadingStep, "#16a34a")}
        >
          {loadingStep === "Krok 5 — Drive verify" ? "Načítám…" : "Krok 5 — Drive revize verify"}
        </button>
      </div>

      <div>
        {results.map((r) => (
          <div key={r.index} style={{ marginBottom: 20, border: "1px solid #ddd", borderRadius: 6, padding: 12 }}>
            <div style={{ fontSize: 13, marginBottom: 8, color: "#333" }}>
              <strong>{r.index}. {r.step}</strong> — {r.timestamp} — HTTP <strong>{r.status}</strong>
            </div>
            <pre
              style={{
                background: "#0d1117", color: "#e6edf3", padding: 12, borderRadius: 4,
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                fontSize: 12, overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word", margin: 0,
                maxHeight: 600,
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
