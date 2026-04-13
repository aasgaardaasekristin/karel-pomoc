import React, { useState } from "react";
import { Database, FileText, CheckCircle, ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import type { CrisisOperationalCard, AuditEntry } from "@/hooks/useCrisisOperationalState";

interface Props {
  card: CrisisOperationalCard;
  onRefetch: () => void;
}

const AuditRow: React.FC<{ entry: AuditEntry }> = ({ entry }) => {
  const statusColor = entry.status === "ok" ? "text-green-600" : entry.status === "failed" ? "text-destructive" : "text-muted-foreground";
  const statusIcon = entry.status === "ok" ? "✅" : entry.status === "failed" ? "❌" : "⏳";
  return (
    <div className="flex items-start gap-2 text-[10px]">
      <span>{statusIcon}</span>
      <div className="flex-1">
        <span className={`font-medium ${statusColor}`}>{entry.source}</span>
        {entry.timestamp && <span className="text-muted-foreground ml-1">{new Date(entry.timestamp).toLocaleString("cs-CZ", { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" })}</span>}
        {entry.detail && <p className="text-muted-foreground">{entry.detail}</p>}
      </div>
    </div>
  );
};

const CrisisAuditPanel: React.FC<Props> = ({ card, onRefetch }) => {
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({});
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const toggleSection = (key: string) => setExpandedSections(prev => ({ ...prev, [key]: !prev[key] }));

  const SectionHeader: React.FC<{ sectionKey: string; icon: React.ReactNode; title: string; badge?: string }> = ({ sectionKey, icon, title, badge }) => (
    <button onClick={() => toggleSection(sectionKey)} className="flex items-center gap-1.5 w-full text-left">
      {expandedSections[sectionKey] ? <ChevronDown className="w-3 h-3 text-muted-foreground" /> : <ChevronRight className="w-3 h-3 text-muted-foreground" />}
      {icon}
      <span className="text-xs font-bold text-foreground">{title}</span>
      {badge && <span className="text-[9px] bg-muted px-1.5 rounded ml-auto">{badge}</span>}
    </button>
  );

  return (
    <div className="space-y-4">
      {/* Card propagation */}
      <div>
        <SectionHeader sectionKey="card_prop" icon={<Database className="w-3.5 h-3.5 text-muted-foreground" />}
          title="Propis do karty části" badge={card.cardPropagationStatus.length > 0 ? `${card.cardPropagationStatus.length} zápisů` : "—"} />
        {expandedSections.card_prop && (
          <div className="mt-2 space-y-1">
            {card.cardPropagationStatus.length === 0 ? (
              <p className="text-[10px] text-muted-foreground">Žádné záznamy o propagaci</p>
            ) : card.cardPropagationStatus.map((e, i) => <AuditRow key={i} entry={e} />)}
          </div>
        )}
      </div>

      {/* 05A sync */}
      <div>
        <SectionHeader sectionKey="plan_sync" icon={<FileText className="w-3.5 h-3.5 text-muted-foreground" />}
          title="05A sync status" badge={card.planSyncStatus ? (card.planSyncStatus.status === "ok" ? "✓" : card.planSyncStatus.status) : "—"} />
        {expandedSections.plan_sync && (
          <div className="mt-2">
            {card.planSyncStatus ? <AuditRow entry={card.planSyncStatus} /> : <p className="text-[10px] text-muted-foreground">Žádný záznam o 05A sync</p>}
          </div>
        )}
      </div>

      {/* Acknowledge */}
      {card.alertId && (
        <div className="flex flex-wrap gap-2 pt-2 border-t">
          <button
            onClick={async () => {
              setActionLoading("acknowledge");
              try {
                const { data: { user } } = await supabase.auth.getUser();
                const userName = user?.email?.includes("kata") ? "kata" : "hanicka";
                await supabase.from("crisis_alerts").update({ status: "ACKNOWLEDGED", acknowledged_by: userName, acknowledged_at: new Date().toISOString() }).eq("id", card.alertId);
                onRefetch();
              } finally { setActionLoading(null); }
            }}
            disabled={actionLoading != null}
            className="text-[11px] px-2.5 py-1.5 rounded-md flex items-center gap-1.5 transition-colors disabled:opacity-50 bg-primary/10 text-primary hover:bg-primary/20"
          >
            {actionLoading === "acknowledge" ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle className="w-3 h-3" />} Vzít na vědomí
          </button>
        </div>
      )}
    </div>
  );
};

export default CrisisAuditPanel;
