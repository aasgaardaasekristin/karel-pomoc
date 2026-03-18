import { useEffect, useMemo, useRef, useState } from "react";
import { Palette, Check, Image, X, Loader2, Save, RotateCcw, Sun, Moon, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { type ThemePrefs, useTheme, hexToHSL, hslToHex } from "@/contexts/ThemeContext";

interface Props {
  partName?: string;
  trigger?: React.ReactNode;
}

const KIDS_PRESETS: Record<string, { label: string; primary_color: string; accent_color: string; emoji: string }> = {
  // Boys themes
  ocean_explorer: { label: "Oceán 🌊", primary_color: "200 38% 42%", accent_color: "190 30% 68%", emoji: "🌊" },
  forest_ranger: { label: "Les 🌲", primary_color: "142 28% 36%", accent_color: "88 22% 62%", emoji: "🌲" },
  space: { label: "Vesmír 🚀", primary_color: "230 30% 32%", accent_color: "260 24% 58%", emoji: "🚀" },
  dragon: { label: "Drak 🐉", primary_color: "14 36% 42%", accent_color: "32 34% 64%", emoji: "🐉" },
  ninja: { label: "Ninja 🥷", primary_color: "220 18% 28%", accent_color: "340 22% 52%", emoji: "🥷" },
  minecraft: { label: "Pixely 🟩", primary_color: "120 32% 38%", accent_color: "36 30% 56%", emoji: "🟩" },
  robot: { label: "Robot 🤖", primary_color: "210 22% 46%", accent_color: "180 20% 62%", emoji: "🤖" },
  pirate: { label: "Pirát 🏴‍☠️", primary_color: "28 38% 38%", accent_color: "45 32% 64%", emoji: "🏴‍☠️" },
  dino: { label: "Dino 🦕", primary_color: "160 28% 40%", accent_color: "130 22% 66%", emoji: "🦕" },
  thunder: { label: "Blesk ⚡", primary_color: "48 40% 44%", accent_color: "210 28% 52%", emoji: "⚡" },
  // Girls themes (fewer)
  fairy: { label: "Víla 🧚", primary_color: "300 24% 52%", accent_color: "330 28% 74%", emoji: "🧚" },
  rainbow: { label: "Duha 🌈", primary_color: "280 26% 48%", accent_color: "340 30% 70%", emoji: "🌈" },
  butterfly: { label: "Motýl 🦋", primary_color: "270 22% 50%", accent_color: "200 26% 68%", emoji: "🦋" },
  flower: { label: "Květ 🌸", primary_color: "340 28% 54%", accent_color: "20 34% 74%", emoji: "🌸" },
  // Neutral
  sunset_beach: { label: "Západ 🌅", primary_color: "24 42% 48%", accent_color: "40 36% 70%", emoji: "🌅" },
  ice: { label: "Led 🧊", primary_color: "200 26% 52%", accent_color: "186 20% 74%", emoji: "🧊" },
};

const FONT_OPTIONS = [
  { value: "default", label: "Výchozí" },
  { value: "comic", label: "Hravé" },
  { value: "rounded", label: "Kulaté" },
  { value: "mono", label: "Kódové" },
] as const;

const DidKidsThemeEditor = ({ partName, trigger }: Props) => {
  const [open, setOpen] = useState(false);
  const { prefs, updatePrefs, uploadBackground, currentPersona, setCurrentPersona } = useTheme();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<ThemePrefs>(prefs);

  useEffect(() => {
    // When opening for kids, switch persona to "kluci"
    if (open && currentPersona !== "kluci") {
      setCurrentPersona("kluci");
    }
  }, [open]);

  useEffect(() => {
    setDraft(prefs);
  }, [prefs, open]);

  const hasPendingChanges = useMemo(() => JSON.stringify(draft) !== JSON.stringify(prefs), [draft, prefs]);

  const setDraftPartial = (partial: Partial<ThemePrefs>) => {
    setDraft((prev) => ({ ...prev, ...partial, persona: "kluci" }));
  };

  const handleApplyTheme = async () => {
    try {
      setSaving(true);
      await updatePrefs(draft);
      toast.success("Vzhled nastaven! 🎨");
    } catch (error: any) {
      toast.error(error?.message || "Nepodařilo se uložit vzhled");
    } finally {
      setSaving(false);
    }
  };

  const handleResetTheme = () => {
    setDraft(prefs);
    toast.info("Změny zrušeny");
  };

  const handleBgUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { toast.error("Max 5 MB"); return; }
    setUploading(true);
    try {
      const url = await uploadBackground(file);
      setDraftPartial({ background_image_url: url });
      toast.success("Obrázek nahrán — klikni Použít");
    } catch (err: any) {
      toast.error(err.message || "Chyba");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger || (
          <Button variant="outline" size="sm" className="h-7 px-2.5 text-[10px] gap-1.5">
            <Palette className="w-3 h-3" />
            Upravit vzhled
          </Button>
        )}
      </DialogTrigger>

      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-sm flex items-center gap-2">
            <Palette className="w-4 h-4 text-primary" />
            {partName ? `Vzhled pro ${partName}` : "Můj vzhled"}
          </DialogTitle>
          <DialogDescription className="text-xs">Vyber si barvy, motiv a styl, jak chceš, aby Karel vypadal.</DialogDescription>
        </DialogHeader>

        {/* Save bar */}
        <div className="rounded-lg border border-primary/20 bg-primary/5 p-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs font-medium text-foreground">
              {hasPendingChanges ? "Máš neuložené změny" : "Vše uloženo ✓"}
            </p>
            {hasPendingChanges && <Badge variant="secondary" className="text-[9px]">Neuloženo</Badge>}
          </div>
          <div className="mt-2 flex gap-2">
            <Button size="sm" className="h-7 text-[10px] gap-1.5" disabled={!hasPendingChanges || saving} onClick={handleApplyTheme}>
              {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
              Použít
            </Button>
            <Button size="sm" variant="outline" className="h-7 text-[10px] gap-1.5" disabled={!hasPendingChanges || saving} onClick={handleResetTheme}>
              <RotateCcw className="w-3 h-3" />
              Zrušit
            </Button>
          </div>
        </div>

        {/* Theme presets grid */}
        <div>
          <p className="text-xs font-medium text-foreground mb-2">Vyber motiv</p>
          <div className="grid grid-cols-4 gap-1.5">
            {Object.entries(KIDS_PRESETS).map(([name, preset]) => (
              <button
                key={name}
                onClick={() => setDraftPartial({ primary_color: preset.primary_color, accent_color: preset.accent_color, theme_preset: name })}
                className={`relative h-12 rounded-lg border-2 transition-all overflow-hidden ${draft.theme_preset === name ? "border-primary ring-1 ring-primary/30 scale-105" : "border-border hover:border-primary/50"}`}
              >
                <div className="absolute inset-0" style={{ background: `linear-gradient(135deg, hsl(${preset.primary_color}) 0%, hsl(${preset.accent_color}) 100%)` }} />
                {draft.theme_preset === name && (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <Check className="w-4 h-4 text-white drop-shadow-md" />
                  </div>
                )}
                <span className="absolute bottom-0.5 left-0 right-0 text-[9px] text-white text-center font-medium drop-shadow-md">
                  {preset.label}
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* Custom color pickers */}
        <div>
          <p className="text-xs font-medium text-foreground mb-2">Vlastní barvy</p>
          <div className="flex gap-3">
            <ColorPicker label="Hlavní" value={draft.primary_color} onChange={(c) => setDraftPartial({ primary_color: c, theme_preset: "custom" })} />
            <ColorPicker label="Doplňková" value={draft.accent_color} onChange={(c) => setDraftPartial({ accent_color: c, theme_preset: "custom" })} />
            {draft.font_color && (
              <ColorPicker label="Písmo" value={draft.font_color} onChange={(c) => setDraftPartial({ font_color: c })} />
            )}
          </div>
          {!draft.font_color && (
            <button onClick={() => setDraftPartial({ font_color: "0 0% 20%" })} className="text-[9px] text-primary mt-1 hover:underline">
              + vlastní barva písma
            </button>
          )}
        </div>

        {/* Font style */}
        <div>
          <p className="text-xs font-medium text-foreground mb-2">Styl písma</p>
          <div className="grid grid-cols-4 gap-1.5">
            {FONT_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setDraftPartial({ font_family: opt.value })}
                className={`py-2 rounded-lg border-2 text-[10px] transition-all ${draft.font_family === opt.value ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:border-primary/50"}`}
                style={{ fontFamily: opt.value === "comic" ? "'Comic Neue', cursive" : opt.value === "rounded" ? "'Nunito', sans-serif" : opt.value === "mono" ? "'JetBrains Mono', monospace" : "inherit" }}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* Preview */}
        <div className="rounded-xl border border-border overflow-hidden bg-card">
          <div className="h-8 flex">
            <div className="flex-1" style={{ background: `hsl(${draft.primary_color})` }} />
            <div className="flex-1" style={{ background: `hsl(${draft.accent_color})` }} />
          </div>
          <div className="p-3 bg-background">
            <p className="text-xs font-medium text-foreground" style={{ color: draft.font_color ? `hsl(${draft.font_color})` : undefined }}>
              Takhle to bude vypadat 🎨
            </p>
            <p className="text-[10px] text-muted-foreground mt-1">Barvy a styl se změní po kliknutí na Použít.</p>
          </div>
        </div>

        {/* Dark mode + font size */}
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
          <Slider value={[draft.font_scale]} min={0.8} max={1.4} step={0.05} onValueChange={([v]) => setDraftPartial({ font_scale: v })} />
        </div>

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sparkles className="w-3.5 h-3.5 text-primary" />
            <span className="text-xs text-foreground">Animace</span>
          </div>
          <Switch checked={draft.animations_enabled} onCheckedChange={(v) => setDraftPartial({ animations_enabled: v })} />
        </div>

        {/* Background image */}
        <div>
          <p className="text-xs font-medium text-foreground mb-2">Pozadí</p>
          {draft.background_image_url ? (
            <div className="relative rounded-lg border border-border overflow-hidden h-20">
              <img src={draft.background_image_url} alt="Pozadí" className="w-full h-full object-cover" />
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
              className="w-full h-14 rounded-lg border-2 border-dashed border-border hover:border-primary/50 flex items-center justify-center gap-2 text-xs text-muted-foreground transition-colors"
            >
              {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Image className="w-4 h-4" />}
              {uploading ? "Nahrávám..." : "Nahrát obrázek"}
            </button>
          )}
          <input ref={fileInputRef} type="file" accept="image/*" onChange={handleBgUpload} className="hidden" />
        </div>
      </DialogContent>
    </Dialog>
  );
};

function ColorPicker({ label, value, onChange }: { label: string; value: string; onChange: (hsl: string) => void }) {
  const hex = hslToHex(value);
  return (
    <label className="flex items-center gap-2 cursor-pointer flex-1">
      <input type="color" value={hex} onChange={(e) => onChange(hexToHSL(e.target.value))} className="w-7 h-7 rounded-lg border border-border cursor-pointer p-0.5 bg-transparent" />
      <div>
        <span className="text-[10px] text-muted-foreground block">{label}</span>
        <span className="text-[9px] font-mono text-muted-foreground">{hex}</span>
      </div>
    </label>
  );
}

export default DidKidsThemeEditor;
