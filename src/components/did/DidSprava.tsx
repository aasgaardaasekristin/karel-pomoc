import { useEffect, useMemo, useRef, useState } from "react";
import { Settings, Database, HeartPulse, RefreshCw, Loader2, Palette, Check, Image, X, Sun, Moon, Sparkles, MessageCircle, Minimize2, Pipette, Save, RotateCcw, ClipboardList, Mail, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { type ThemePrefs, useTheme, hexToHSL, hslToHex } from "@/contexts/ThemeContext";
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
  refreshTrigger?: number;
  onSelectPart?: (partName: string) => void;
}

const PERSONA_LABELS: Record<string, string> = {
  default: "Výchozí",
  hanka: "Hanička 🌸",
  kata: "Káťa 🦋",
};

const RADIUS_OPTIONS = [
  { value: "sharp", label: "Ostré", icon: "◻" },
  { value: "normal", label: "Normální", icon: "▢" },
  { value: "round", label: "Kulaté", icon: "⬭" },
  { value: "pill", label: "Pilulka", icon: "⏺" },
] as const;

const BUBBLE_OPTIONS = [
  { value: "rounded", label: "Kulaté" },
  { value: "square", label: "Hranaté" },
  { value: "minimal", label: "Minimální" },
] as const;

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
  const { prefs, presets, updatePrefs, uploadBackground, currentPersona, setCurrentPersona } = useTheme();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<ThemePrefs>(prefs);

  useEffect(() => {
    setDraft(prefs);
  }, [prefs, currentPersona, open]);

  const hasPendingChanges = useMemo(() => JSON.stringify(draft) !== JSON.stringify(prefs), [draft, prefs]);

  const setDraftPartial = (partial: Partial<ThemePrefs>) => {
    setDraft((prev) => ({ ...prev, ...partial, persona: currentPersona }));
  };

  const handleApplyTheme = async () => {
    try {
      setSaving(true);
      await updatePrefs(draft);
      toast.success("Vzhled použit");
    } catch (error: any) {
      toast.error(error?.message || "Nepodařilo se uložit vzhled");
    } finally {
      setSaving(false);
    }
  };

  const handleResetTheme = () => {
    setDraft(prefs);
    toast.info("Rozpracované změny zrušeny");
  };

  const handleBgUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      toast.error("Obrázek je příliš velký (max 5 MB)");
      return;
    }

    setUploading(true);
    try {
      const url = await uploadBackground(file);
      setDraftPartial({ background_image_url: url });
      toast.success("Pozadí připraveno — klikni na Použít změny");
    } catch (err: any) {
      toast.error(err.message || "Chyba při nahrávání");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

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
          <div className="space-y-4">
            <div className="rounded-lg border border-primary/20 bg-primary/5 p-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-medium text-foreground">Použití změn</p>
                  <p className="text-[10px] text-muted-foreground">Změny se projeví až po stisku tlačítka níže.</p>
                </div>
                {hasPendingChanges && <Badge variant="secondary" className="text-[9px]">Neuloženo</Badge>}
              </div>

              <div className="mt-3 flex gap-2">
                <Button size="sm" className="h-7 text-[10px] gap-1.5" disabled={!hasPendingChanges || saving} onClick={handleApplyTheme}>
                  {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
                  Použít změny
                </Button>
                <Button size="sm" variant="outline" className="h-7 text-[10px] gap-1.5" disabled={!hasPendingChanges || saving} onClick={handleResetTheme}>
                  <RotateCcw className="w-3 h-3" />
                  Zrušit
                </Button>
              </div>
            </div>

            <div>
              <p className="text-xs font-medium text-foreground mb-2">Personalizace pro:</p>
              <div className="flex gap-1 flex-wrap">
                {Object.entries(PERSONA_LABELS).map(([key, label]) => (
                  <Button
                    key={key}
                    variant={currentPersona === key ? "default" : "outline"}
                    size="sm"
                    onClick={() => setCurrentPersona(key)}
                    className="h-7 text-[10px] px-2"
                  >
                    {label}
                  </Button>
                ))}
              </div>
            </div>

            <div>
              <p className="text-xs font-medium text-foreground mb-2">Barevné motivy</p>
              <div className="grid grid-cols-4 gap-1.5">
                {Object.entries(presets).map(([name, preset]) => (
                  <button
                    key={name}
                    onClick={() => setDraftPartial({ primary_color: preset.primary_color!, accent_color: preset.accent_color!, theme_preset: name })}
                    className={`relative h-10 rounded-lg border-2 transition-all overflow-hidden ${draft.theme_preset === name ? "border-primary ring-1 ring-primary/30" : "border-border hover:border-primary/50"}`}
                  >
                    <div
                      className="absolute inset-0"
                      style={{ background: `linear-gradient(135deg, hsl(${preset.primary_color}) 0%, hsl(${preset.accent_color}) 100%)` }}
                    />
                    {draft.theme_preset === name && (
                      <div className="absolute inset-0 flex items-center justify-center">
                        <Check className="w-3.5 h-3.5 text-white drop-shadow-md" />
                      </div>
                    )}
                    <span className="absolute bottom-0.5 left-0 right-0 text-[8px] text-white text-center font-medium drop-shadow-md capitalize">
                      {name}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <p className="text-xs font-medium text-foreground mb-2 flex items-center gap-1.5">
                <Pipette className="w-3 h-3" />
                Vlastní barvy
              </p>
              <div className="flex gap-3 flex-wrap">
                <ColorPicker label="Hlavní" value={draft.primary_color} onChange={(c) => setDraftPartial({ primary_color: c, theme_preset: "custom" })} />
                <ColorPicker label="Doplňková" value={draft.accent_color} onChange={(c) => setDraftPartial({ accent_color: c, theme_preset: "custom" })} />
                {draft.font_color ? (
                  <ColorPicker label="Písmo" value={draft.font_color} onChange={(c) => setDraftPartial({ font_color: c })} />
                ) : (
                  <button onClick={() => setDraftPartial({ font_color: "0 0% 20%" })} className="text-[9px] text-primary self-end hover:underline pb-1">
                    + barva písma
                  </button>
                )}
              </div>
            </div>

            <div>
              <p className="text-xs font-medium text-foreground mb-2">Styl písma</p>
              <div className="grid grid-cols-4 gap-1.5">
                {([
                  { value: "default", label: "Výchozí" },
                  { value: "comic", label: "Hravé" },
                  { value: "rounded", label: "Kulaté" },
                  { value: "mono", label: "Kódové" },
                ] as const).map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => setDraftPartial({ font_family: opt.value })}
                    className={`py-1.5 rounded-lg border-2 text-[10px] transition-all ${draft.font_family === opt.value ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:border-primary/50"}`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="rounded-xl border border-border overflow-hidden bg-card">
              <div className="h-10 flex">
                <div className="flex-1" style={{ background: `hsl(${draft.primary_color})` }} />
                <div className="flex-1" style={{ background: `hsl(${draft.accent_color})` }} />
              </div>
              <div className="grid grid-cols-2 gap-2 p-3 bg-background">
                <div className="rounded-lg border p-2" style={{ borderColor: `hsl(${draft.primary_color} / 0.3)` }}>
                  <p className="text-[10px] text-muted-foreground">Karta</p>
                  <p className="text-xs font-medium text-foreground">Náhled tématu</p>
                </div>
                <div className="rounded-lg p-2 text-[11px]" style={{ background: `hsl(${draft.primary_color})`, color: draft.dark_mode ? `hsl(${draft.primary_color} / 0.1)` : "white" }}>
                  Tlačítko
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                {draft.dark_mode ? <Moon className="w-3.5 h-3.5 text-primary" /> : <Sun className="w-3.5 h-3.5 text-primary" />}
                <span className="text-xs text-foreground">Tmavý režim</span>
              </div>
              <Switch checked={draft.dark_mode} onCheckedChange={(v) => setDraftPartial({ dark_mode: v })} />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs text-foreground">Velikost písma</span>
                <Badge variant="outline" className="text-[9px] h-4 px-1.5">{Math.round(draft.font_scale * 100)}%</Badge>
              </div>
              <Slider value={[draft.font_scale]} min={0.8} max={1.3} step={0.05} onValueChange={([v]) => setDraftPartial({ font_scale: v })} />
            </div>

            <div>
              <p className="text-xs font-medium text-foreground mb-2">Zaoblení rohů</p>
              <div className="grid grid-cols-4 gap-1.5">
                {RADIUS_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => setDraftPartial({ border_radius: opt.value })}
                    className={`py-1.5 rounded-lg border-2 text-center transition-all ${draft.border_radius === opt.value ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:border-primary/50"}`}
                  >
                    <span className="block text-sm">{opt.icon}</span>
                    <span className="text-[9px]">{opt.label}</span>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <p className="text-xs font-medium text-foreground mb-2 flex items-center gap-1.5">
                <MessageCircle className="w-3 h-3" />
                Styl chatových bublin
              </p>
              <div className="grid grid-cols-3 gap-1.5">
                {BUBBLE_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => setDraftPartial({ chat_bubble_style: opt.value })}
                    className={`py-2 rounded-lg border-2 text-[10px] transition-all ${draft.chat_bubble_style === opt.value ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:border-primary/50"}`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Minimize2 className="w-3.5 h-3.5 text-primary" />
                <span className="text-xs text-foreground">Kompaktní režim</span>
              </div>
              <Switch checked={draft.compact_mode} onCheckedChange={(v) => setDraftPartial({ compact_mode: v })} />
            </div>

            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Sparkles className="w-3.5 h-3.5 text-primary" />
                <span className="text-xs text-foreground">Animace</span>
              </div>
              <Switch checked={draft.animations_enabled} onCheckedChange={(v) => setDraftPartial({ animations_enabled: v })} />
            </div>

            <div>
              <p className="text-xs font-medium text-foreground mb-2">Pozadí</p>
              {draft.background_image_url ? (
                <div className="relative rounded-lg border border-border overflow-hidden h-20">
                  <img src={draft.background_image_url} alt="Náhled pozadí" className="w-full h-full object-cover" />
                  <button
                    onClick={() => setDraftPartial({ background_image_url: "" })}
                    className="absolute top-1 right-1 p-1 rounded-full bg-background/80 hover:bg-destructive/80 transition-colors"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                  className="w-full h-16 rounded-lg border-2 border-dashed border-border hover:border-primary/50 flex items-center justify-center gap-2 text-xs text-muted-foreground transition-colors"
                >
                  {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Image className="w-4 h-4" />}
                  {uploading ? "Nahrávám..." : "Nahrát obrázek pozadí"}
                </button>
              )}
              <input ref={fileInputRef} type="file" accept="image/*" onChange={handleBgUpload} className="hidden" />
            </div>
          </div>
        )}
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

function ColorPicker({ label, value, onChange }: { label: string; value: string; onChange: (hsl: string) => void }) {
  const hex = hslToHex(value);

  return (
    <label className="flex items-center gap-2 cursor-pointer flex-1">
      <input
        type="color"
        value={hex}
        onChange={(e) => onChange(hexToHSL(e.target.value))}
        className="w-8 h-8 rounded-lg border border-border cursor-pointer p-0.5 bg-transparent"
      />
      <div>
        <span className="text-[10px] text-muted-foreground block">{label}</span>
        <span className="text-[9px] font-mono text-muted-foreground">{hex}</span>
      </div>
    </label>
  );
}

export default DidSprava;
