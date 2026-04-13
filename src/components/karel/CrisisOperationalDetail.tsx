import React, { useState } from "react";
import type { CrisisOperationalCard } from "@/hooks/useCrisisOperationalState";
import CrisisDailyManagement from "./CrisisDailyManagement";
import CrisisSessionQA from "./CrisisSessionQA";
import CrisisClosureWorkflow from "./CrisisClosureWorkflow";
import CrisisAuditPanel from "./CrisisAuditPanel";
import CrisisHistoryTimeline from "./CrisisHistoryTimeline";

interface Props {
  card: CrisisOperationalCard;
  onRefetch: () => void;
}

type TabKey = "management" | "closure" | "history" | "audit";

const TABS: { key: TabKey; label: string }[] = [
  { key: "management", label: "Řízení" },
  { key: "closure", label: "Uzavření" },
  { key: "history", label: "Historie" },
  { key: "audit", label: "Audit" },
];

const CrisisOperationalDetail: React.FC<Props> = ({ card, onRefetch }) => {
  const [activeTab, setActiveTab] = useState<TabKey>("management");

  return (
    <div className="border-x border-b rounded-b-lg mx-2 mb-1 bg-background shadow-lg" style={{ borderColor: "#7C2D2D30" }}>
      {/* Tab bar */}
      <div className="flex border-b text-xs">
        {TABS.map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`flex-1 py-2 font-medium transition-colors ${activeTab === tab.key ? "bg-primary/10 text-primary border-b-2 border-primary" : "text-muted-foreground hover:text-foreground"}`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="p-4 max-h-[60vh] overflow-y-auto">
        {activeTab === "management" && (
          <div className="space-y-4">
            <CrisisDailyManagement card={card} onRefetch={onRefetch} />
            <CrisisSessionQA card={card} onRefetch={onRefetch} />
          </div>
        )}
        {activeTab === "closure" && <CrisisClosureWorkflow card={card} onRefetch={onRefetch} />}
        {activeTab === "history" && <CrisisHistoryTimeline card={card} />}
        {activeTab === "audit" && <CrisisAuditPanel card={card} onRefetch={onRefetch} />}
      </div>
    </div>
  );
};

export default CrisisOperationalDetail;
