// FIX 9.K.1b — ChildThreadSwitcher
import React, { useEffect, useState } from "react";

export type OpenThread = {
  id: string;
  child_part_id: string;
  child_part_name: string;
  last_active_at: string;
  status: "open";
};

type Props = {
  current_thread_id: string | null;
  threads: OpenThread[];
  onSelect: (t: OpenThread) => void;
};

const ACCENT = "#E8C547";
const PARCH = "#F4E9C8";
const PANEL = "#2A2440";
const BG = "#1E1B2E";

function dotColor(iso: string): string {
  const dt = Date.now() - new Date(iso).getTime();
  if (dt < 30 * 60 * 1000) return "#5CE891";       // zelená
  if (dt < 3 * 60 * 60 * 1000) return "#E8C547";   // žlutá
  return "#7A6F8A";                                // šedá
}

function fmtTime(iso: string) {
  try {
    return new Date(iso).toLocaleTimeString("cs-CZ", { hour: "2-digit", minute: "2-digit" });
  } catch { return ""; }
}

const ChildThreadSwitcher: React.FC<Props> = ({ current_thread_id, threads, onSelect }) => {
  return (
    <div style={{
      background: PANEL, borderBottom: `1px solid ${ACCENT}33`,
      padding: "8px 12px", overflowX: "auto", whiteSpace: "nowrap",
      fontFamily: "'DM Sans', system-ui, sans-serif",
    }}>
      {threads.length === 0 && (
        <span style={{ color: "#9A8FB0", fontStyle: "italic", fontSize: 13 }}>
          Žádné otevřené vlákno dnes.
        </span>
      )}
      {threads.map((t) => {
        const active = t.id === current_thread_id;
        return (
          <button
            key={t.id}
            onClick={() => onSelect(t)}
            title={`Naposledy psáno v ${fmtTime(t.last_active_at)}`}
            style={{
              display: "inline-flex", alignItems: "center", gap: 8,
              background: active ? BG : "transparent",
              color: active ? ACCENT : PARCH,
              border: `1px solid ${active ? ACCENT : ACCENT + "33"}`,
              borderRadius: 18, padding: "5px 12px", marginRight: 8,
              cursor: "pointer", fontSize: 13,
            }}
          >
            <span style={{
              width: 8, height: 8, borderRadius: 4, background: dotColor(t.last_active_at),
              display: "inline-block",
            }} />
            {t.child_part_name}
            {active && <span style={{ fontSize: 11, opacity: 0.85 }}>(aktivní)</span>}
          </button>
        );
      })}
    </div>
  );
};

export default ChildThreadSwitcher;
