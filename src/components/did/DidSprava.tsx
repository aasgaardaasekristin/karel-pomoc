import { useState } from "react";
import { Settings, Database, HeartPulse, RefreshCw, Loader2, ClipboardList, Trash2, Brain } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { toast } from "sonner";
import ThemeEditorDialog from "@/components/ThemeEditorDialog";
import DidKartotekaHealth from "./DidKartotekaHealth";
import DidRegistryOverview from "./DidRegistryOverview";
import DidReportDiagnostics from "./DidReportDiagnostics";

interface Props {
  onBootstrap: () => void;
  isBootstrapping: boolean;
  onHealthAudit: () => void;
  isAuditing: boolean;
  onReformat?: () => void;
  isReformatting?: boolean;
  onManualUpdate?: () => void;
  isUpdating?: boolean;
  onCentrumSync?: () => void;
  isCentrumSyncing?: boolean;
  onCleanupTasks?: () => void;
  isCleaningTasks?: boolean;
  onRefreshMemory?: () => void;
  isRefreshingMemory?: boolean;
  refreshTrigger?: number;
  onSelectPart?: (partName: string) => void;
}


const DidSprava = ({
  onBootstrap,
  isBootstrapping,
  onHealthAudit,
  isAuditing,
  onReformat,
  isReformatting,
  onManualUpdate,
  isUpdating,
  onCentrumSync,
  isCentrumSyncing,
  onCleanupTasks,
  isCleaningTasks,
  refreshTrigger = 0,
  onSelectPart,
}: Props) => {
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"tools" | "theme" | "health" | "registry" | "reports">("tools");
  const [themeDialogOpen, setThemeDialogOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="h-7 px-2.5 text-[10px] gap-1.5">
          <Settings className="w-3 h-3" />
          Správa
        </Button>
      </DialogTrigger>

      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-sm flex items-center gap-2">
            <Settings className="w-4 h-4 text-primary" />
            Správa DID režimu
          </DialogTitle>
          <DialogDescription className="text-xs">Nástroje a osobní nastavení vzhledu pro každou personu zvlášť.</DialogDescription>
        </DialogHeader>

        <div className="flex gap-1 mb-3 p-0.5 rounded-lg bg-muted flex-wrap">
          {([
            { key: "tools" as const, label: "🛠 Nástroje" },
            { key: "health" as const, label: "❤️ Zdraví" },
            { key: "registry" as const, label: "📋 Registr" },
            { key: "reports" as const, label: "📧 Reporty" },
            { key: "theme" as const, label: "🎨 Vzhled" },
          ]).map(tab => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`flex-1 text-xs py-1.5 rounded-md transition-colors ${activeTab === tab.key ? "bg-background text-foreground shadow-sm" : "text-muted-foreground"}`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {activeTab === "tools" && (
          <div className="space-y-2">
            {onManualUpdate && (
              <ToolButton
                icon={<RefreshCw className={`w-4 h-4 text-primary ${isUpdating ? "animate-spin" : ""}`} />}
                title="Aktualizovat kartotéku"
                desc="Synchronizace dat z rozhovorů do karet na Drive"
                loading={isUpdating}
                onClick={() => { onManualUpdate(); setOpen(false); }}
              />
            )}

            {onCentrumSync && (
              <ToolButton
                icon={<ClipboardList className={`w-4 h-4 text-emerald-600 ${isCentrumSyncing ? "animate-pulse" : ""}`} />}
                title="Aktualizovat Centrum"
                desc="Synchronizace CENTRUM dokumentů na Drive"
                loading={isCentrumSyncing}
                onClick={() => { onCentrumSync(); setOpen(false); }}
              />
            )}

            {onCleanupTasks && (
              <ToolButton
                icon={<Trash2 className={`w-4 h-4 text-amber-600 ${isCleaningTasks ? "animate-pulse" : ""}`} />}
                title="Vyčistit úkoly"
                desc="Archivovat not_started úkoly starší 7 dní"
                loading={isCleaningTasks}
                onClick={() => { onCleanupTasks(); setOpen(false); }}
              />
            )}

            <ToolButton
              icon={<HeartPulse className={`w-4 h-4 text-primary ${isAuditing ? "animate-pulse" : ""}`} />}
              title="Audit zdraví kartotéky"
              desc="Kontrola integrity a úplnosti karet"
              loading={isAuditing}
              onClick={() => { onHealthAudit(); setOpen(false); }}
            />

            {onReformat && (
              <ToolButton
                icon={<RefreshCw className={`w-4 h-4 text-primary ${isReformatting ? "animate-spin" : ""}`} />}
                title="Přeformátovat karty"
                desc="Sjednocení formátu všech karet"
                loading={isReformatting}
                onClick={() => { onReformat(); setOpen(false); }}
              />
            )}

            <ToolButton
              icon={<Database className={`w-4 h-4 text-primary ${isBootstrapping ? "animate-pulse" : ""}`} />}
              title="Bootstrap DID paměti"
              desc="Jednorázové nasátí všech karet z Drive do registru"
              loading={isBootstrapping}
              onClick={() => { onBootstrap(); setOpen(false); }}
            />
          </div>
        )}

        {activeTab === "health" && (
          <div className="space-y-2">
            <DidKartotekaHealth refreshTrigger={refreshTrigger} />
          </div>
        )}

        {activeTab === "registry" && (
          <div className="space-y-2">
            <DidRegistryOverview
              refreshTrigger={refreshTrigger}
              onSelectPart={onSelectPart}
            />
          </div>
        )}

        {activeTab === "reports" && (
          <div className="space-y-2">
            <DidReportDiagnostics refreshTrigger={refreshTrigger} />
          </div>
        )}

        {activeTab === "theme" && (
          <div className="flex flex-col items-center gap-3 py-4">
            <p className="text-xs text-muted-foreground">Nastavení vzhledu bylo přesunuto do vlastního dialogu.</p>
            <Button size="sm" className="h-8 text-xs gap-1.5" onClick={() => { setOpen(false); setThemeDialogOpen(true); }}>
              🎨 Otevřít nastavení vzhledu
            </Button>
          </div>
        )}
        <ThemeEditorDialog open={themeDialogOpen} onOpenChange={setThemeDialogOpen} />
      </DialogContent>
    </Dialog>
  );
};

function ToolButton({ icon, title, desc, loading, onClick }: {
  icon: React.ReactNode;
  title: string;
  desc: string;
  loading?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={loading}
      className={`w-full flex flex-col gap-0 p-3 rounded-lg border transition-colors text-left ${
        loading
          ? "border-primary/30 bg-primary/5 cursor-wait"
          : "border-border hover:bg-muted/50"
      }`}
    >
      <div className="flex items-center gap-3 w-full">
        {icon}
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium text-foreground">{title}</p>
          <p className="text-[10px] text-muted-foreground">
            {loading ? "Probíhá..." : desc}
          </p>
        </div>
        {loading && <Loader2 className="w-3 h-3 animate-spin ml-auto shrink-0" />}
      </div>
      {loading && (
        <div className="w-full mt-2 h-1 rounded-full bg-primary/10 overflow-hidden">
          <div className="h-full w-1/4 rounded-full bg-primary/60 animate-indeterminate-progress" />
        </div>
      )}
    </button>
  );
}



export default DidSprava;
