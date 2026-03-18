import { useState, useEffect, useRef, useCallback } from "react";
import { Clock, AlertTriangle, Loader2, BookOpen, ListChecks, FileText, BarChart3, Upload, Database, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";
import DidSystemMap from "./DidSystemMap";
import { getAuthHeaders } from "@/lib/auth";
import { toast } from "sonner";
import ReactMarkdown from "react-markdown";
import { syncOverviewTasksToBoard } from "@/lib/parseOverviewTasks";
import type { DidSubMode } from "./DidSubModeSelector";
import DidTherapistTaskBoard from "./DidTherapistTaskBoard";
import DidAgreementsPanel from "./DidAgreementsPanel";
import DidSessionPrep from "./DidSessionPrep";
import DidMonthlyPanel from "./DidMonthlyPanel";
import DidPulseCheck from "./DidPulseCheck";
import DidColleagueView from "./DidColleagueView";
import DidKartotekaHealth from "./DidKartotekaHealth";
import DidRegistryOverview from "./DidRegistryOverview";
...
      {/* Colleague View */}
      <div className="mb-4">
        <DidColleagueView refreshTrigger={refreshTrigger} />
      </div>

      {/* Registry Overview (Phase 5) */}
      <div className="mb-4">
        <DidRegistryOverview refreshTrigger={refreshTrigger} onSelectPart={onQuickThread ? (partName) => onQuickThread("", partName) : undefined} />
      </div>

      {/* Kartotéka Health Check */}
      <div className="mb-4">
        <DidKartotekaHealth refreshTrigger={refreshTrigger} />
      </div>

      {/* DID Memory Bootstrap */}
      <div className="mb-4 rounded-lg border border-border bg-card/50 p-3 sm:p-4">
        <div className="flex items-center justify-between">
          <h4 className="text-xs font-medium text-foreground flex items-center gap-1.5">
            <Database className="w-3.5 h-3.5 text-primary" />
            Bootstrap DID paměti
          </h4>
          <Button
            variant="outline"
            size="sm"
            onClick={runDidBootstrap}
            disabled={isBootstrapping}
            className="h-7 text-[10px] px-3"
          >
            {isBootstrapping ? (
              <><Loader2 className="w-3 h-3 animate-spin mr-1" />Zpracovávám...</>
            ) : (
              "Spustit bootstrap"
            )}
          </Button>
        </div>
        <p className="text-[10px] text-muted-foreground mt-1">
          Jednorázové nasátí všech karet z Drive do registru částí a sémantické paměti.
        </p>
        {bootstrapProgress && (
          <div className="mt-2">
            <div className="flex items-center justify-between text-[10px] text-muted-foreground mb-1">
              <span>{bootstrapProgress.current}/{bootstrapProgress.total} — {bootstrapProgress.currentName}</span>
              <span>{Math.round((bootstrapProgress.current / bootstrapProgress.total) * 100)}%</span>
            </div>
            <div className="w-full h-1.5 bg-muted rounded-full overflow-hidden">
              <div
                className="h-full bg-primary rounded-full transition-all duration-300"
                style={{ width: `${(bootstrapProgress.current / bootstrapProgress.total) * 100}%` }}
              />
            </div>
          </div>
        )}
      </div>

      {/* System Map */}
      <DidSystemMap
        parts={parts}
        activeThreads={activeThreads}
        onQuickThread={onQuickThread}
        onDeletePart={async (partName) => {
          // Delete all threads for this part from the database
          const { error } = await supabase
            .from("did_threads")
            .delete()
            .eq("part_name", partName)
            .eq("sub_mode", "cast");
          if (error) {
            toast.error(`Nepodařilo se smazat vlákna pro ${partName}`);
          } else {
            toast.success(`Vlákna pro „${partName}" smazána z mapy`);
            setParts(prev => prev.filter(p => p.name !== partName));
            setActiveThreads(prev => prev.filter(t => t.partName !== partName));
          }
        }}
      />

      {/* Warnings */}
      {parts.filter(p => p.status === "warning").length > 0 && (
        <div className="mt-3 rounded-lg border border-yellow-500/50 bg-yellow-500/10 p-3">
          <div className="flex items-center gap-2 text-sm font-medium text-yellow-600 mb-1">
            <AlertTriangle className="w-4 h-4" />
            Upozornění na neaktivní části
          </div>
          <p className="text-xs text-muted-foreground">
            {parts.filter(p => p.status === "warning").map(p => p.name).join(", ")} – neaktivní více než 7 dní. Zvažte oslovení.
          </p>
        </div>
      )}
    </div>
  );
};

export default DidDashboard;
