import { useState, useRef } from "react";
import { Settings, Database, HeartPulse, RefreshCw, Loader2, Palette, Upload, Check, Image, X, Sun, Moon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { getAuthHeaders } from "@/lib/auth";
import { toast } from "sonner";
import { useTheme } from "@/contexts/ThemeContext";

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

const DidSprava = ({
  onBootstrap,
  isBootstrapping,
  onHealthAudit,
  isAuditing,
  onReformat,
  isReformatting,
  onManualUpdate,
  isUpdating,
}: Props) => {
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"tools" | "theme">("tools");
  const { prefs, presets, updatePrefs, applyPreset, uploadBackground, currentPersona, setCurrentPersona } = useTheme();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

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
      await updatePrefs({ background_image_url: url });
      toast.success("Pozadí nastaveno");
    } catch (err: any) {
      toast.error(err.message || "Chyba při nahrávání");
    } finally {
      setUploading(false);
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
        </DialogHeader>

        {/* Tab toggle */}
        <div className="flex gap-1 mb-3 p-0.5 rounded-lg bg-muted">
          <button
            onClick={() => setActiveTab("tools")}
            className={`flex-1 text-xs py-1.5 rounded-md transition-colors ${activeTab === "tools" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground"}`}
          >
            🛠 Nástroje
          </button>
          <button
            onClick={() => setActiveTab("theme")}
            className={`flex-1 text-xs py-1.5 rounded-md transition-colors ${activeTab === "theme" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground"}`}
          >
            <Palette className="w-3 h-3 inline mr-1" />
            Vzhled
          </button>
        </div>

        {activeTab === "tools" && (
          <div className="space-y-2">
            {onManualUpdate && (
              <button
                onClick={() => { onManualUpdate(); setOpen(false); }}
                disabled={isUpdating}
                className="w-full flex items-center gap-3 p-3 rounded-lg border border-border hover:bg-muted/50 transition-colors text-left"
              >
                <RefreshCw className={`w-4 h-4 text-primary ${isUpdating ? "animate-spin" : ""}`} />
                <div>
                  <p className="text-xs font-medium text-foreground">Aktualizovat kartotéku</p>
                  <p className="text-[10px] text-muted-foreground">Synchronizace dat z rozhovorů do karet na Drive</p>
                </div>
                {isUpdating && <Loader2 className="w-3 h-3 animate-spin ml-auto" />}
              </button>
            )}

            <button
              onClick={() => { onHealthAudit(); setOpen(false); }}
              disabled={isAuditing}
              className="w-full flex items-center gap-3 p-3 rounded-lg border border-border hover:bg-muted/50 transition-colors text-left"
            >
              <HeartPulse className={`w-4 h-4 text-primary ${isAuditing ? "animate-pulse" : ""}`} />
              <div>
                <p className="text-xs font-medium text-foreground">Audit zdraví kartotéky</p>
                <p className="text-[10px] text-muted-foreground">Kontrola integrity a úplnosti karet</p>
              </div>
              {isAuditing && <Loader2 className="w-3 h-3 animate-spin ml-auto" />}
            </button>

            {onReformat && (
              <button
                onClick={() => { onReformat(); setOpen(false); }}
                disabled={isReformatting}
                className="w-full flex items-center gap-3 p-3 rounded-lg border border-border hover:bg-muted/50 transition-colors text-left"
              >
                <RefreshCw className={`w-4 h-4 text-primary ${isReformatting ? "animate-spin" : ""}`} />
                <div>
                  <p className="text-xs font-medium text-foreground">Přeformátovat karty</p>
                  <p className="text-[10px] text-muted-foreground">Sjednocení formátu všech karet v kartotéce</p>
                </div>
                {isReformatting && <Loader2 className="w-3 h-3 animate-spin ml-auto" />}
              </button>
            )}

            <button
              onClick={() => { onBootstrap(); setOpen(false); }}
              disabled={isBootstrapping}
              className="w-full flex items-center gap-3 p-3 rounded-lg border border-border hover:bg-muted/50 transition-colors text-left"
            >
              <Database className={`w-4 h-4 text-primary ${isBootstrapping ? "animate-pulse" : ""}`} />
              <div>
                <p className="text-xs font-medium text-foreground">Bootstrap DID paměti</p>
                <p className="text-[10px] text-muted-foreground">Jednorázové nasátí všech karet z Drive do registru</p>
              </div>
              {isBootstrapping && <Loader2 className="w-3 h-3 animate-spin ml-auto" />}
            </button>
          </div>
        )}

        {activeTab === "theme" && (
          <div className="space-y-4">
            {/* Persona selector */}
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

            {/* Presets */}
            <div>
              <p className="text-xs font-medium text-foreground mb-2">Barevné motivy</p>
              <div className="grid grid-cols-4 gap-1.5">
                {Object.entries(presets).map(([name, preset]) => (
                  <button
                    key={name}
                    onClick={() => applyPreset(name)}
                    className={`relative h-10 rounded-lg border-2 transition-all overflow-hidden ${
                      prefs.theme_preset === name ? "border-primary ring-1 ring-primary/30" : "border-border hover:border-primary/50"
                    }`}
                  >
                    <div
                      className="absolute inset-0"
                      style={{
                        background: `linear-gradient(135deg, hsl(${preset.primary_color}) 0%, hsl(${preset.accent_color}) 100%)`,
                      }}
                    />
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

            {/* Dark mode */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                {prefs.dark_mode ? <Moon className="w-3.5 h-3.5 text-primary" /> : <Sun className="w-3.5 h-3.5 text-primary" />}
                <span className="text-xs text-foreground">Tmavý režim</span>
              </div>
              <Switch
                checked={prefs.dark_mode}
                onCheckedChange={(v) => updatePrefs({ dark_mode: v })}
              />
            </div>

            {/* Font scale */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs text-foreground">Velikost písma</span>
                <Badge variant="outline" className="text-[9px] h-4 px-1.5">{Math.round(prefs.font_scale * 100)}%</Badge>
              </div>
              <Slider
                value={[prefs.font_scale]}
                min={0.8}
                max={1.3}
                step={0.05}
                onValueChange={([v]) => updatePrefs({ font_scale: v })}
              />
            </div>

            {/* Background image */}
            <div>
              <p className="text-xs font-medium text-foreground mb-2">Pozadí</p>
              {prefs.background_image_url ? (
                <div className="relative rounded-lg border border-border overflow-hidden h-20">
                  <img src={prefs.background_image_url} alt="bg" className="w-full h-full object-cover" />
                  <button
                    onClick={() => updatePrefs({ background_image_url: "" })}
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
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={handleBgUpload}
                className="hidden"
              />
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};

export default DidSprava;
