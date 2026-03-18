import { useState, useRef } from "react";
import { Settings, Database, HeartPulse, RefreshCw, Loader2, Palette, Check, Image, X, Sun, Moon, Sparkles, MessageCircle, Minimize2, Pipette } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogDescription } from "@/components/ui/dialog";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { useTheme, hexToHSL, hslToHex } from "@/contexts/ThemeContext";

interface Props {
  onBootstrap: () => void;
  isBootstrapping: boolean;
  onHealthAudit: () => void;
  isAuditing: boolean;
  onReformat?: () => void;
  isReformatting?: boolean;
  onManualUpdate?: () => void;
  isUpdating?: boolean;
}

const PERSONA_LABELS: Record<string, string> = {
  default: "Výchozí",
  hanka: "Hanička 🌸",
  kata: "Káťa 🦋",
  kluci: "Kluci 🧩",
};

const RADIUS_OPTIONS = [
  { value: "sharp", label: "Ostré", icon: "◻" },
  { value: "normal", label: "Normální", icon: "▢" },
  { value: "round", label: "Kulaté", icon: "⬭" },
  { value: "pill", label: "Pilulka", icon: "⏺" },
];

const BUBBLE_OPTIONS = [
  { value: "rounded", label: "Kulaté" },
  { value: "square", label: "Hranaté" },
  { value: "minimal", label: "Minimální" },
];

const DidSprava = ({
  onBootstrap, isBootstrapping, onHealthAudit, isAuditing,
  onReformat, isReformatting, onManualUpdate, isUpdating,
}: Props) => {
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"tools" | "theme">("tools");
  const { prefs, presets, updatePrefs, applyPreset, uploadBackground, currentPersona, setCurrentPersona } = useTheme();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const handleBgUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { toast.error("Max 5 MB"); return; }
    setUploading(true);
    try {
      const url = await uploadBackground(file);
      await updatePrefs({ background_image_url: url });
      toast.success("Pozadí nastaveno");
    } catch (err: any) {
      toast.error(err.message || "Chyba");
    } finally { setUploading(false); }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="h-7 px-2.5 text-[10px] gap-1.5">
          <Settings className="w-3 h-3" /> Správa
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-sm flex items-center gap-2">
            <Settings className="w-4 h-4 text-primary" /> Správa DID režimu
          </DialogTitle>
          <DialogDescription className="text-xs">Nástroje a přizpůsobení vzhledu</DialogDescription>
        </DialogHeader>

        <div className="flex gap-1 mb-3 p-0.5 rounded-lg bg-muted">
          <button onClick={() => setActiveTab("tools")}
            className={`flex-1 text-xs py-1.5 rounded-md transition-colors ${activeTab === "tools" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground"}`}>
            🛠 Nástroje
          </button>
          <button onClick={() => setActiveTab("theme")}
            className={`flex-1 text-xs py-1.5 rounded-md transition-colors ${activeTab === "theme" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground"}`}>
            <Palette className="w-3 h-3 inline mr-1" /> Vzhled
          </button>
        </div>

        {activeTab === "tools" && (
          <div className="space-y-2">
            {onManualUpdate && (
              <ToolButton icon={<RefreshCw className={`w-4 h-4 text-primary ${isUpdating ? "animate-spin" : ""}`} />}
                title="Aktualizovat kartotéku" desc="Synchronizace dat z rozhovorů do karet na Drive"
                loading={isUpdating} onClick={() => { onManualUpdate(); setOpen(false); }} />
            )}
            <ToolButton icon={<HeartPulse className={`w-4 h-4 text-primary ${isAuditing ? "animate-pulse" : ""}`} />}
              title="Audit zdraví kartotéky" desc="Kontrola integrity a úplnosti karet"
              loading={isAuditing} onClick={() => { onHealthAudit(); setOpen(false); }} />
            {onReformat && (
              <ToolButton icon={<RefreshCw className={`w-4 h-4 text-primary ${isReformatting ? "animate-spin" : ""}`} />}
                title="Přeformátovat karty" desc="Sjednocení formátu všech karet"
                loading={isReformatting} onClick={() => { onReformat(); setOpen(false); }} />
            )}
            <ToolButton icon={<Database className={`w-4 h-4 text-primary ${isBootstrapping ? "animate-pulse" : ""}`} />}
              title="Bootstrap DID paměti" desc="Nasátí všech karet z Drive do registru"
              loading={isBootstrapping} onClick={() => { onBootstrap(); setOpen(false); }} />
          </div>
        )}

        {activeTab === "theme" && (
          <div className="space-y-4">
            {/* Persona selector */}
            <div>
              <p className="text-xs font-medium text-foreground mb-2">Personalizace pro:</p>
              <div className="flex gap-1 flex-wrap">
                {Object.entries(PERSONA_LABELS).map(([key, label]) => (
                  <Button key={key} variant={currentPersona === key ? "default" : "outline"} size="sm"
                    onClick={() => setCurrentPersona(key)} className="h-7 text-[10px] px-2">
                    {label}
                  </Button>
                ))}
              </div>
            </div>

            {/* Color presets */}
            <div>
              <p className="text-xs font-medium text-foreground mb-2">Barevné motivy</p>
              <div className="grid grid-cols-4 gap-1.5">
                {Object.entries(presets).map(([name, preset]) => (
                  <button key={name} onClick={() => applyPreset(name)}
                    className={`relative h-10 rounded-lg border-2 transition-all overflow-hidden ${
                      prefs.theme_preset === name ? "border-primary ring-1 ring-primary/30" : "border-border hover:border-primary/50"}`}>
                    <div className="absolute inset-0" style={{
                      background: `linear-gradient(135deg, hsl(${preset.primary_color}) 0%, hsl(${preset.accent_color}) 100%)`
                    }} />
                    {prefs.theme_preset === name && (
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

            {/* Custom color pickers */}
            <div>
              <p className="text-xs font-medium text-foreground mb-2 flex items-center gap-1.5">
                <Pipette className="w-3 h-3" /> Vlastní barvy
              </p>
              <div className="flex gap-3">
                <ColorPicker label="Hlavní" value={prefs.primary_color}
                  onChange={(c) => updatePrefs({ primary_color: c, theme_preset: "custom" })} />
                <ColorPicker label="Doplňková" value={prefs.accent_color}
                  onChange={(c) => updatePrefs({ accent_color: c, theme_preset: "custom" })} />
              </div>
            </div>

            {/* Live preview swatch */}
            <div className="h-8 rounded-lg overflow-hidden border border-border flex">
              <div className="flex-1" style={{ background: `hsl(${prefs.primary_color})` }} />
              <div className="flex-1" style={{ background: `hsl(${prefs.accent_color})` }} />
              <div className="flex-1 bg-background flex items-center justify-center">
                <span className="text-[9px] text-foreground">Náhled</span>
              </div>
            </div>

            {/* Dark mode */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                {prefs.dark_mode ? <Moon className="w-3.5 h-3.5 text-primary" /> : <Sun className="w-3.5 h-3.5 text-primary" />}
                <span className="text-xs text-foreground">Tmavý režim</span>
              </div>
              <Switch checked={prefs.dark_mode} onCheckedChange={(v) => updatePrefs({ dark_mode: v })} />
            </div>

            {/* Font scale */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs text-foreground">Velikost písma</span>
                <Badge variant="outline" className="text-[9px] h-4 px-1.5">{Math.round(prefs.font_scale * 100)}%</Badge>
              </div>
              <Slider value={[prefs.font_scale]} min={0.8} max={1.3} step={0.05}
                onValueChange={([v]) => updatePrefs({ font_scale: v })} />
            </div>

            {/* Border radius */}
            <div>
              <p className="text-xs font-medium text-foreground mb-2">Zaoblení rohů</p>
              <div className="grid grid-cols-4 gap-1.5">
                {RADIUS_OPTIONS.map((opt) => (
                  <button key={opt.value} onClick={() => updatePrefs({ border_radius: opt.value })}
                    className={`py-1.5 rounded-lg border-2 text-center transition-all ${
                      prefs.border_radius === opt.value ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:border-primary/50"}`}>
                    <span className="block text-sm">{opt.icon}</span>
                    <span className="text-[9px]">{opt.label}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Chat bubble style */}
            <div>
              <p className="text-xs font-medium text-foreground mb-2 flex items-center gap-1.5">
                <MessageCircle className="w-3 h-3" /> Styl chatových bublin
              </p>
              <div className="grid grid-cols-3 gap-1.5">
                {BUBBLE_OPTIONS.map((opt) => (
                  <button key={opt.value} onClick={() => updatePrefs({ chat_bubble_style: opt.value })}
                    className={`py-2 rounded-lg border-2 text-[10px] transition-all ${
                      prefs.chat_bubble_style === opt.value ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:border-primary/50"}`}>
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Compact mode */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Minimize2 className="w-3.5 h-3.5 text-primary" />
                <span className="text-xs text-foreground">Kompaktní režim</span>
              </div>
              <Switch checked={prefs.compact_mode} onCheckedChange={(v) => updatePrefs({ compact_mode: v })} />
            </div>

            {/* Animations */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Sparkles className="w-3.5 h-3.5 text-primary" />
                <span className="text-xs text-foreground">Animace</span>
              </div>
              <Switch checked={prefs.animations_enabled} onCheckedChange={(v) => updatePrefs({ animations_enabled: v })} />
            </div>

            {/* Background image */}
            <div>
              <p className="text-xs font-medium text-foreground mb-2">Pozadí</p>
              {prefs.background_image_url ? (
                <div className="relative rounded-lg border border-border overflow-hidden h-20">
                  <img src={prefs.background_image_url} alt="bg" className="w-full h-full object-cover" />
                  <button onClick={() => updatePrefs({ background_image_url: "" })}
                    className="absolute top-1 right-1 p-1 rounded-full bg-background/80 hover:bg-destructive/80 transition-colors">
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ) : (
                <button onClick={() => fileInputRef.current?.click()} disabled={uploading}
                  className="w-full h-16 rounded-lg border-2 border-dashed border-border hover:border-primary/50 flex items-center justify-center gap-2 text-xs text-muted-foreground transition-colors">
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

/* ---------- sub-components ---------- */

function ToolButton({ icon, title, desc, loading, onClick }: {
  icon: React.ReactNode; title: string; desc: string; loading?: boolean; onClick: () => void;
}) {
  return (
    <button onClick={onClick} disabled={loading}
      className="w-full flex items-center gap-3 p-3 rounded-lg border border-border hover:bg-muted/50 transition-colors text-left">
      {icon}
      <div>
        <p className="text-xs font-medium text-foreground">{title}</p>
        <p className="text-[10px] text-muted-foreground">{desc}</p>
      </div>
      {loading && <Loader2 className="w-3 h-3 animate-spin ml-auto" />}
    </button>
  );
}

function ColorPicker({ label, value, onChange }: { label: string; value: string; onChange: (hsl: string) => void }) {
  const hex = hslToHex(value);
  return (
    <label className="flex items-center gap-2 cursor-pointer flex-1">
      <input type="color" value={hex}
        onChange={(e) => onChange(hexToHSL(e.target.value))}
        className="w-8 h-8 rounded-lg border border-border cursor-pointer p-0.5 bg-transparent" />
      <div>
        <span className="text-[10px] text-muted-foreground block">{label}</span>
        <span className="text-[9px] font-mono text-muted-foreground">{hex}</span>
      </div>
    </label>
  );
}

export default DidSprava;
