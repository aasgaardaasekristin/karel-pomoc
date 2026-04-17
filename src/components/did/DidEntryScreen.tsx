import { useEffect, useMemo, useState } from "react";

interface Props {
  onSelectTerapeut: () => void;
  onSelectKluci: () => void;
  onBack: () => void;
}

/* ── Greeting tied to time of day ── */
function getGreeting(): string {
  const h = new Date().getHours();
  if (h < 5) return "Tichá noc";
  if (h < 10) return "Dobré ráno";
  if (h < 14) return "Dobré poledne";
  if (h < 18) return "Dobré odpoledne";
  if (h < 22) return "Dobrý večer";
  return "Klidný čas";
}

/* ── Roman day-of-month — gives the entry an editorial frontispiece ── */
const ROMAN = ["", "I","II","III","IV","V","VI","VII","VIII","IX","X","XI","XII","XIII","XIV","XV","XVI","XVII","XVIII","XIX","XX","XXI","XXII","XXIII","XXIV","XXV","XXVI","XXVII","XXVIII","XXIX","XXX","XXXI"];
function romanDay(d: number): string {
  return ROMAN[d] || String(d);
}

const MONTHS = ["ledna","února","března","dubna","května","června","července","srpna","září","října","listopadu","prosince"];

const DidEntryScreen = ({ onSelectTerapeut, onSelectKluci, onBack: _onBack }: Props) => {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);

  const meta = useMemo(() => {
    const greeting = getGreeting();
    const day = now.getDate();
    const month = MONTHS[now.getMonth()];
    return {
      greeting,
      dateLine: `${romanDay(day)} · ${day}. ${month}`,
    };
  }, [now]);

  return (
    <div className="min-h-[70vh] flex items-center justify-center px-4 py-10 sm:py-16">
      <div className="w-full max-w-3xl">
        {/* ── Frontispiece ── */}
        <header className="text-center mb-10 sm:mb-14 animate-fade-in">
          <div className="karel-briefing-eyebrow mb-3" style={{ color: "hsl(28 18% 52%)" }}>
            Karel · {meta.dateLine}
          </div>
          <h1 className="font-serif font-medium tracking-tight text-foreground/90"
              style={{ fontSize: "clamp(1.75rem, 4vw, 2.4rem)", lineHeight: 1.1, fontFamily: "'Crimson Pro', Georgia, serif" }}>
            {meta.greeting}.
          </h1>
          <p className="mt-3 text-foreground/55 italic"
             style={{ fontFamily: "'Crimson Pro', Georgia, serif", fontSize: "1.05rem", lineHeight: 1.5 }}>
            Vyberte, kterým vchodem dnes chcete projít.
          </p>
        </header>

        {/* ── Two worlds ── */}
        <div className="grid gap-5 sm:grid-cols-2">
          {/* Therapist gate — Jung's study */}
          <button
            type="button"
            onClick={onSelectTerapeut}
            className="karel-gate karel-gate-jung text-left animate-fade-in min-h-[280px] sm:min-h-[340px] focus:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(28_42%_38%/0.6)] focus-visible:ring-offset-2"
            style={{ animationDelay: "60ms", animationFillMode: "both" }}
            aria-label="Vstoupit do terapeutického prostoru"
          >
            <div className="karel-gate-content h-full flex flex-col justify-between p-6 sm:p-8">
              <div className="flex items-start justify-between gap-4">
                <div className="karel-gate-eyebrow">Pracovna</div>
                <div className="karel-gate-sigil" aria-hidden>☉</div>
              </div>

              <div className="mt-6 sm:mt-10">
                <h2 className="karel-gate-title">Terapeut</h2>
                <p className="mt-3 karel-gate-deck">
                  Hanička, Káťa a porady týmu.<br/>
                  Místo soustředění, supervize a tichého rozvažování.
                </p>
              </div>

              <div className="mt-6 sm:mt-8 flex items-center justify-between">
                <span className="karel-gate-meta">
                  Dashboard · Karlův přehled · Porada
                </span>
                <span aria-hidden className="text-[hsl(28_36%_38%)] text-xl leading-none transition-transform group-hover:translate-x-0.5">
                  →
                </span>
              </div>
            </div>
          </button>

          {/* Boys gate — Wizarding world */}
          <button
            type="button"
            onClick={onSelectKluci}
            className="karel-gate karel-gate-wizard text-left animate-fade-in min-h-[280px] sm:min-h-[340px] focus:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(38_50%_70%/0.6)] focus-visible:ring-offset-2"
            style={{ animationDelay: "150ms", animationFillMode: "both" }}
            aria-label="Vstoupit do prostoru kluků"
          >
            <div className="karel-gate-content h-full flex flex-col justify-between p-6 sm:p-8">
              <div className="flex items-start justify-between gap-4">
                <div className="karel-gate-eyebrow">Vnitřní svět</div>
                <div className="karel-gate-sigil" aria-hidden>✦</div>
              </div>

              <div className="mt-6 sm:mt-10">
                <h2 className="karel-gate-title">Kluci</h2>
                <p className="mt-3 karel-gate-deck">
                  Vlastní vlákna a rozhovor s Karlem.<br/>
                  Bezpečný průchod mezi částmi systému.
                </p>
              </div>

              <div className="mt-6 sm:mt-8 flex items-center justify-between">
                <span className="karel-gate-meta">
                  Vlákna · Karty · Komnaty
                </span>
                <span aria-hidden className="text-[hsl(38_50%_78%)] text-xl leading-none">
                  →
                </span>
              </div>
            </div>
          </button>
        </div>

        {/* ── Footer note ── */}
        <p className="mt-10 text-center text-[11px] tracking-[0.16em] uppercase text-foreground/40"
           style={{ fontFamily: "'DM Sans', system-ui, sans-serif" }}>
          Jeden mozek · dvě atmosféry
        </p>
      </div>
    </div>
  );
};

export default DidEntryScreen;
