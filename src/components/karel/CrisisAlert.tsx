import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { X, Shield, MessageSquare, RefreshCw, ChevronDown, ChevronUp, CalendarPlus, FileEdit, CheckCircle } from "lucide-react";
import { toast } from "sonner";
import { useCrisisOperationalState } from "@/hooks/useCrisisOperationalState";
import CrisisOperationalDetail from "./CrisisOperationalDetail";

const PHASE_LABELS: Record<string, string> = {
  acute: "akutní",
  stabilizing: "stabilizace",
  diagnostic: "diagnostika",
  closing: "uzavírání",
};

const TREND_EMOJI: Record<string, string> = {
  improving: "📈",
  stable: "➡️",
  worsening: "📉",
  unknown: "",
};

const CrisisAlert: React.FC = () => {
  const navigate = useNavigate();
  const { cards, loading, refetch } = useCrisisOperationalState();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [evalLoading, setEvalLoading] = useState(false);

  const [dismissedIds, setDismissedIds] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem("dismissed_crisis_banners");
      return stored ? new Set(JSON.parse(stored)) : new Set();
    } catch { return new Set(); }
  });

  const handleDismiss = (id: string) => {
    setDismissedIds(prev => {
      const next = new Set(prev).add(id);
      localStorage.setItem("dismissed_crisis_banners", JSON.stringify([...next]));
      return next;
    });
  };

  const handleEvaluate = async (eventId: string) => {
    setEvalLoading(true);
    try {
      const projectId = import.meta.env.VITE_SUPABASE_PROJECT_ID;
      const token = (await supabase.auth.getSession()).data.session?.access_token;
      await fetch(`https://${projectId}.supabase.co/functions/v1/evaluate-crisis`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ crisisId: eventId }),
      });
      refetch();
    } catch { /* silent */ }
    setEvalLoading(false);
  };

  const handleRequestUpdate = async (card: typeof cards[0]) => {
    try {
      await supabase.from("did_therapist_tasks").insert({
        task: `Zapsat krizový update pro ${card.displayName} — poslední kontakt ${Math.round(card.hoursStale)}h`,
        assigned_to: "hanka",
        status: "pending",
        priority: "high",
        source: "crisis_banner",
        user_id: "00000000-0000-0000-0000-000000000000",
      });
      toast.success(`Požadavek na update pro ${card.displayName} vytvořen`);
      refetch();
    } catch { toast.error("Nepodařilo se vytvořit požadavek"); }
  };

  const handlePlanSession = async (card: typeof cards[0]) => {
    try {
      await supabase.from("did_therapist_tasks").insert({
        task: `Naplánovat krizové sezení s ${card.displayName} — den ${card.daysActive ?? "?"}, riziko ${card.lastAssessmentRisk || "?"}`,
        assigned_to: "hanka",
        status: "pending",
        priority: "high",
        source: "crisis_banner",
        user_id: "00000000-0000-0000-0000-000000000000",
      });
      toast.success(`Sezení s ${card.displayName} naplánováno jako úkol`);
    } catch { toast.error("Nepodařilo se naplánovat sezení"); }
  };

  if (loading || cards.length === 0) return null;

  const visibleCards = cards.filter(c => {
    const id = c.eventId || c.alertId || c.partName;
    return !dismissedIds.has(id);
  });

  if (visibleCards.length === 0) return null;

  return (
    <div className="sticky top-0 z-50">
      {visibleCards.map(card => {
        const id = card.eventId || card.alertId || card.partName;
        const isExpanded = expandedId === id;
        const trendEmoji = TREND_EMOJI[card.trend48h] || "";

        return (
          <div key={id}>
            {/* ── Banner line ── */}
            <div className="text-white px-4 py-2" style={{ backgroundColor: "#7C2D2D" }}>
              <div className="max-w-[900px] mx-auto flex items-center gap-2 text-[13px]">
                {/* Left: core operational data */}
                <div className="flex items-center gap-2 min-w-0 flex-1 flex-wrap">
                  <Shield className="w-4 h-4 shrink-0" />
                  <span className="font-bold">{card.displayName}</span>
                  <span className="text-white/70 text-[11px]">
                    {card.severity}
                  </span>
                  <span className="text-white/60 text-[11px]">
                    {card.phase ? PHASE_LABELS[card.phase] || card.phase : "aktivní"}
                    {card.daysActive ? ` · den ${card.daysActive}` : ""}
                  </span>
                  {trendEmoji && (
                    <span className="text-[11px]">{trendEmoji}</span>
                  )}
                  {card.lastAssessmentDate && (
                    <span className="text-white/50 text-[10px]">
                      záznam: {card.lastAssessmentDate}
                    </span>
                  )}
                  {card.isStale && (
                    <span className="text-[10px] bg-yellow-500/30 text-yellow-100 px-1.5 py-0.5 rounded">
                      ⚠ {Math.round(card.hoursStale)}h bez kontaktu
                    </span>
                  )}
                  {card.karelRequires.length > 0 && (
                    <span className="text-[10px] bg-blue-400/30 text-blue-100 px-1.5 py-0.5 rounded">
                      vyžaduje {card.karelRequires.length}×
                    </span>
                  )}
                  <span className="text-white/40 text-[10px]">
                    {card.primaryTherapist}
                  </span>
                </div>

                {/* Right: CTA actions */}
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => handleRequestUpdate(card)}
                    className="hover:bg-white/10 px-2 py-1 rounded text-[11px] flex items-center gap-1 transition-colors"
                    title="Zapsat krizový update"
                  >
                    <FileEdit className="w-3 h-3" />
                    <span className="hidden sm:inline">Update</span>
                  </button>
                  <button
                    onClick={() => {
                      if (card.conversationId) navigate(`/chat?meeting=${card.conversationId}`);
                      else navigate(`/chat?sub=meeting`);
                    }}
                    className="hover:bg-white/10 px-2 py-1 rounded text-[11px] flex items-center gap-1 transition-colors"
                    title="Otevřít krizovou poradu"
                  >
                    <MessageSquare className="w-3 h-3" />
                    <span className="hidden sm:inline">Porada</span>
                  </button>
                  <button
                    onClick={() => handlePlanSession(card)}
                    className="hover:bg-white/10 px-2 py-1 rounded text-[11px] flex items-center gap-1 transition-colors"
                    title="Naplánovat sezení"
                  >
                    <CalendarPlus className="w-3 h-3" />
                    <span className="hidden sm:inline">Sezení</span>
                  </button>
                  {card.canEvaluate && (
                    <button
                      onClick={() => handleEvaluate(card.eventId!)}
                      disabled={evalLoading}
                      className="hover:bg-white/10 px-2 py-1 rounded text-[11px] flex items-center gap-1 transition-colors"
                      title="Spustit dnešní hodnocení"
                    >
                      <RefreshCw className={`w-3 h-3 ${evalLoading ? "animate-spin" : ""}`} />
                      <span className="hidden sm:inline">Hodnocení</span>
                    </button>
                  )}
                  {card.canStartClosing && (
                    <button
                      onClick={() => setExpandedId(isExpanded ? null : id)}
                      className="hover:bg-white/10 px-2 py-1 rounded text-[11px] flex items-center gap-1 transition-colors text-green-200"
                      title="Navrhnout uzavření"
                    >
                      <CheckCircle className="w-3 h-3" />
                      <span className="hidden sm:inline">Uzavřít</span>
                    </button>
                  )}
                  <button
                    onClick={() => setExpandedId(isExpanded ? null : id)}
                    className="hover:bg-white/10 px-1.5 py-1 rounded transition-colors"
                    title={isExpanded ? "Skrýt detail" : "Zobrazit detail"}
                  >
                    {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                  </button>
                  <button
                    onClick={() => handleDismiss(id)}
                    className="hover:bg-white/10 p-1 rounded"
                    title="Skrýt banner"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              </div>
            </div>

            {/* ── Expandable operational detail ── */}
            {isExpanded && (
              <CrisisOperationalDetail card={card} onRefetch={refetch} />
            )}
          </div>
        );
      })}
    </div>
  );
};

export default CrisisAlert;
