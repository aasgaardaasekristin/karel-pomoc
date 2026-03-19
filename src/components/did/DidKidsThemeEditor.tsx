import { useEffect, useMemo, useRef, useState } from "react";
import { Palette, Check, Image, X, Loader2, Save, RotateCcw, Sun, Moon, Sparkles, Lock, MessageCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { type ThemePrefs, useTheme, hexToHSL, hslToHex } from "@/contexts/ThemeContext";
import { supabase } from "@/integrations/supabase/client";

interface Props {
  partName?: string;
  trigger?: React.ReactNode;
  /** When set, saves the chosen preset to the thread */
  threadId?: string;
  onThreadThemeSaved?: (threadId: string, presetKey: string, config: Record<string, any>) => void;
}

export const KIDS_PRESETS: Record<string, { label: string; primary_color: string; accent_color: string; emoji: string; effect?: string }> = {
  ocean_explorer: { label: "Oceán 🌊", primary_color: "200 38% 42%", accent_color: "190 30% 68%", emoji: "🌊", effect: "wave" },
  forest_ranger: { label: "Les 🌲", primary_color: "142 28% 36%", accent_color: "88 22% 62%", emoji: "🌲", effect: "grow" },
  space: { label: "Vesmír 🚀", primary_color: "230 30% 32%", accent_color: "260 24% 58%", emoji: "🚀", effect: "float" },
  dragon: { label: "Drak 🐉", primary_color: "14 36% 42%", accent_color: "32 34% 64%", emoji: "🐉", effect: "shake" },
  ninja: { label: "Ninja 🥷", primary_color: "220 18% 28%", accent_color: "340 22% 52%", emoji: "🥷", effect: "fade" },
  minecraft: { label: "Pixely 🟩", primary_color: "120 32% 38%", accent_color: "36 30% 56%", emoji: "🟩", effect: "pixel" },
  robot: { label: "Robot 🤖", primary_color: "210 22% 46%", accent_color: "180 20% 62%", emoji: "🤖", effect: "pulse" },
  pirate: { label: "Pirát 🏴‍☠️", primary_color: "28 38% 38%", accent_color: "45 32% 64%", emoji: "🏴‍☠️", effect: "wave" },
  dino: { label: "Dino 🦕", primary_color: "160 28% 40%", accent_color: "130 22% 66%", emoji: "🦕", effect: "grow" },
  thunder: { label: "Blesk ⚡", primary_color: "48 40% 44%", accent_color: "210 28% 52%", emoji: "⚡", effect: "shake" },
  fairy: { label: "Víla 🧚", primary_color: "300 24% 52%", accent_color: "330 28% 74%", emoji: "🧚", effect: "float" },
  rainbow: { label: "Duha 🌈", primary_color: "280 26% 48%", accent_color: "340 30% 70%", emoji: "🌈", effect: "pulse" },
  butterfly: { label: "Motýl 🦋", primary_color: "270 22% 50%", accent_color: "200 26% 68%", emoji: "🦋", effect: "float" },
  flower: { label: "Květ 🌸", primary_color: "340 28% 54%", accent_color: "20 34% 74%", emoji: "🌸", effect: "grow" },
  sunset_beach: { label: "Západ 🌅", primary_color: "24 42% 48%", accent_color: "40 36% 70%", emoji: "🌅", effect: "fade" },
  ice: { label: "Led 🧊", primary_color: "200 26% 52%", accent_color: "186 20% 74%", emoji: "🧊", effect: "pulse" },
};

const SECRET_PRESET = { label: "??? 🔮", primary_color: "270 40% 36%", accent_color: "320 35% 60%", emoji: "🔮" };
const SECRET_UNLOCK_COUNT = 5;

const FONT_OPTIONS = [
  { value: "default", label: "Výchozí", preview: "Aa" },
  { value: "comic", label: "Hravé", preview: "Aa" },
  { value: "rounded", label: "Kulaté", preview: "Aa" },
  { value: "mono", label: "Kódové", preview: "01" },
] as const;

const THREAD_EMOJIS = ["🐱", "🐶", "🦊", "🐸", "🐻", "🦁", "🐼", "🐨", "🐯", "🦄", "🐲", "👾", "🤖", "👻", "⭐", "🎮"];

const PRESET_BACKGROUNDS = [
  { key: "space", label: "Vesmír 🚀", url: "https://images.unsplash.com/photo-1462331940025-496dfbfc7564?w=800&q=80", gradient: "linear-gradient(135deg, #0f0c29, #302b63, #24243e)" },
  { key: "forest", label: "Les 🌲", url: "https://images.unsplash.com/photo-1448375240586-882707db888b?w=800&q=80", gradient: "linear-gradient(135deg, #134e5e, #71b280)" },
  { key: "ocean", label: "Oceán 🌊", url: "https://images.unsplash.com/photo-1507525428034-b723cf961d3e?w=800&q=80", gradient: "linear-gradient(135deg, #2193b0, #6dd5ed)" },
  { key: "dragon", label: "Drak 🐉", url: "https://images.unsplash.com/photo-1518709268805-4e9042af9f23?w=800&q=80", gradient: "linear-gradient(135deg, #c31432, #240b36)" },
];

const DidKidsThemeEditor = ({ partName, trigger, threadId, onThreadThemeSaved }: Props) => {
  const [open, setOpen] = useState(false);
  const { prefs, updatePrefs, uploadBackground, currentPersona, setCurrentPersona, applyTemporaryTheme } = useTheme();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<ThemePrefs & { thread_emoji?: string }>(prefs);
  const [selectedEffect, setSelectedEffect] = useState<string | null>(null);
  const [secretUnlocked, setSecretUnlocked] = useState(false);
  const [visitCount, setVisitCount] = useState(0);

  useEffect(() => {
    if (open) {
      if (currentPersona !== "kluci") setCurrentPersona("kluci");
      // Track visits for secret preset
      const key = `karel_kids_theme_visits_${partName || "global"}`;
      try {
        const count = Number(localStorage.getItem(key) || "0") + 1;
        localStorage.setItem(key, String(count));
        setVisitCount(count);
        if (count >= SECRET_UNLOCK_COUNT) setSecretUnlocked(true);
      } catch {}
    }
  }, [open]);

  useEffect(() => {
    setDraft(prefs);
  }, [prefs, open]);

  const hasPendingChanges = useMemo(() => JSON.stringify(draft) !== JSON.stringify(prefs), [draft, prefs]);

  const setDraftPartial = (partial: Partial<ThemePrefs & { thread_emoji?: string }>) => {
    setDraft((prev) => ({ ...prev, ...partial, persona: "kluci" }));
  };

  const handleApplyTheme = async () => {
    try {
      setSaving(true);
      
      const config: Record<string, any> = {
        primary_color: draft.primary_color,
        accent_color: draft.accent_color,
        dark_mode: draft.dark_mode,
        font_family: draft.font_family,
        font_scale: draft.font_scale,
        background_image_url: draft.background_image_url,
        thread_emoji: (draft as any).thread_emoji || "",
      };

      if (threadId) {
        // THREAD-SCOPED: only apply temporarily + save to thread, do NOT write to global user_theme_preferences
        applyTemporaryTheme(draft);
        
        if (onThreadThemeSaved) {
          onThreadThemeSaved(threadId, draft.theme_preset || "custom", config);
        }
        // Silent mapping: log theme preference for profiling
        logThemePreference(partName || "", draft.theme_preset || "custom", config, threadId);
      } else {
        // GLOBAL: write to user_theme_preferences as before
        await updatePrefs(draft);
      }
      
      toast.success(
        threadId 
          ? `Vzhled pro ${partName || "vlákno"} uložen! 🎨` 
          : "Vzhled nastaven! 🎨",
        { duration: 2000 }
      );
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
            {threadId ? "Můj vzhled" : "Upravit vzhled"}
          </Button>
        )}
      </DialogTrigger>

      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-sm flex items-center gap-2">
            <Palette className="w-4 h-4 text-primary" />
            {partName ? `Vzhled pro ${partName}` : "Můj vzhled"}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {threadId
              ? "⚡ Tento vzhled platí jen pro toto vlákno — jiných se nedotkne!"
              : "Vyber si barvy, motiv a styl, jak chceš, aby Karel vypadal."}
          </DialogDescription>
        </DialogHeader>

        {/* Per-thread warning banner */}
        {threadId && (
          <div className="rounded-lg border border-accent/30 bg-accent/10 p-2.5 flex items-center gap-2">
            <span className="text-lg">🎯</span>
            <p className="text-[10px] text-foreground/80">
              Tvůj vzhled se uloží do tohoto vlákna. Příště se automaticky načte!
            </p>
          </div>
        )}

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
              Použít{threadId ? " pro toto vlákno" : ""}
            </Button>
            <Button size="sm" variant="outline" className="h-7 text-[10px] gap-1.5" disabled={!hasPendingChanges || saving} onClick={handleResetTheme}>
              <RotateCcw className="w-3 h-3" />
              Zrušit
            </Button>
          </div>
        </div>

        {/* Thread emoji picker */}
        {threadId && (
          <div>
            <p className="text-xs font-medium text-foreground mb-2">Tvůj avatar 🎭</p>
            <div className="flex flex-wrap gap-1.5">
              {THREAD_EMOJIS.map((emoji) => (
                <button
                  key={emoji}
                  onClick={() => setDraftPartial({ thread_emoji: emoji } as any)}
                  className={`w-9 h-9 rounded-lg border-2 text-lg flex items-center justify-center transition-all hover:scale-110 ${(draft as any).thread_emoji === emoji ? "border-primary bg-primary/10 scale-110" : "border-border hover:border-primary/50"}`}
                >
                  {emoji}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Theme presets grid */}
        <div>
          <p className="text-xs font-medium text-foreground mb-2">Vyber motiv</p>
          <div className="grid grid-cols-4 gap-1.5">
            {Object.entries(KIDS_PRESETS).map(([name, preset]) => (
              <button
                key={name}
                onClick={() => {
                  setDraftPartial({ primary_color: preset.primary_color, accent_color: preset.accent_color, theme_preset: name });
                  setSelectedEffect(preset.effect || null);
                  // Auto-clear effect after animation
                  setTimeout(() => setSelectedEffect(null), 600);
                }}
                className={`relative h-14 rounded-lg border-2 transition-all overflow-hidden group ${
                  draft.theme_preset === name 
                    ? "border-primary ring-1 ring-primary/30 scale-105" 
                    : "border-border hover:border-primary/50 hover:scale-[1.03]"
                } ${selectedEffect && draft.theme_preset === name ? `animate-${selectedEffect === "shake" ? "pulse" : "scale-in"}` : ""}`}
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
                {/* Hover emoji pop */}
                <span className="absolute top-0.5 right-0.5 text-sm opacity-0 group-hover:opacity-100 transition-opacity">
                  {preset.emoji}
                </span>
              </button>
            ))}
            {/* Secret preset */}
            {secretUnlocked ? (
              <button
                onClick={() => setDraftPartial({ primary_color: SECRET_PRESET.primary_color, accent_color: SECRET_PRESET.accent_color, theme_preset: "secret_magic" })}
                className={`relative h-14 rounded-lg border-2 transition-all overflow-hidden ${
                  draft.theme_preset === "secret_magic" ? "border-primary ring-1 ring-primary/30 scale-105" : "border-border hover:border-primary/50"
                }`}
              >
                <div className="absolute inset-0" style={{ background: `linear-gradient(135deg, hsl(${SECRET_PRESET.primary_color}) 0%, hsl(${SECRET_PRESET.accent_color}) 100%)` }} />
                <span className="absolute bottom-0.5 left-0 right-0 text-[9px] text-white text-center font-medium drop-shadow-md">
                  {SECRET_PRESET.label}
                </span>
              </button>
            ) : (
              <div className="relative h-14 rounded-lg border-2 border-dashed border-border flex items-center justify-center opacity-50">
                <Lock className="w-4 h-4 text-muted-foreground" />
                <span className="text-[8px] text-muted-foreground absolute bottom-0.5">
                  {SECRET_UNLOCK_COUNT - visitCount > 0 ? `ještě ${SECRET_UNLOCK_COUNT - visitCount}×` : ""}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Live chat preview — "Vyzkoušej si to" */}
        <div>
          <p className="text-xs font-medium text-foreground mb-2 flex items-center gap-1.5">
            <MessageCircle className="w-3.5 h-3.5" />
            Vyzkoušej si to
          </p>
          <div className="rounded-xl border border-border overflow-hidden" style={{ background: `linear-gradient(180deg, hsl(${draft.primary_color} / 0.08) 0%, hsl(${draft.accent_color} / 0.05) 100%)` }}>
            <div className="p-3 space-y-2">
              {/* Assistant bubble */}
              <div className="flex gap-2 items-end">
                <span className="text-base">{(draft as any).thread_emoji || "🤖"}</span>
                <div className="rounded-2xl rounded-bl-sm px-3 py-2 max-w-[75%] text-[11px]" style={{ 
                  background: `hsl(${draft.primary_color} / 0.15)`,
                  color: draft.font_color ? `hsl(${draft.font_color})` : undefined,
                  fontFamily: draft.font_family === "comic" ? "'Comic Neue', cursive" : draft.font_family === "rounded" ? "'Nunito', sans-serif" : draft.font_family === "mono" ? "'JetBrains Mono', monospace" : "inherit",
                }}>
                  Ahoj {partName || "ty"}! Jak se dneska máš? 😊
                </div>
              </div>
              {/* User bubble */}
              <div className="flex gap-2 items-end justify-end">
                <div className="rounded-2xl rounded-br-sm px-3 py-2 max-w-[75%] text-[11px]" style={{
                  background: `hsl(${draft.accent_color} / 0.2)`,
                  color: draft.font_color ? `hsl(${draft.font_color})` : undefined,
                  fontFamily: draft.font_family === "comic" ? "'Comic Neue', cursive" : draft.font_family === "rounded" ? "'Nunito', sans-serif" : draft.font_family === "mono" ? "'JetBrains Mono', monospace" : "inherit",
                }}>
                  Dneska dobře! 🎉
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Custom color pickers with gradient preview */}
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
          {/* Gradient preview bar */}
          <div className="mt-2 h-3 rounded-full overflow-hidden border border-border" style={{ background: `linear-gradient(90deg, hsl(${draft.primary_color}) 0%, hsl(${draft.accent_color}) 100%)` }} />
        </div>

        {/* Font style */}
        <div>
          <p className="text-xs font-medium text-foreground mb-2">Styl písma</p>
          <div className="grid grid-cols-4 gap-1.5">
            {FONT_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setDraftPartial({ font_family: opt.value })}
                className={`py-2.5 rounded-lg border-2 transition-all ${draft.font_family === opt.value ? "border-primary bg-primary/10 text-foreground scale-105" : "border-border text-muted-foreground hover:border-primary/50 hover:scale-[1.02]"}`}
                style={{ fontFamily: opt.value === "comic" ? "'Comic Neue', cursive" : opt.value === "rounded" ? "'Nunito', sans-serif" : opt.value === "mono" ? "'JetBrains Mono', monospace" : "inherit" }}
              >
                <span className="text-lg block">{opt.preview}</span>
                <span className="text-[9px] block mt-0.5">{opt.label}</span>
              </button>
            ))}
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
          
          {/* Preset backgrounds grid */}
          <div className="grid grid-cols-4 gap-1.5 mb-2">
            {PRESET_BACKGROUNDS.map((bg) => (
              <button
                key={bg.key}
                onClick={() => setDraftPartial({ background_image_url: bg.url })}
                className={`relative h-12 rounded-lg border-2 overflow-hidden transition-all ${
                  draft.background_image_url === bg.url 
                    ? "border-primary ring-1 ring-primary/30 scale-105" 
                    : "border-border hover:border-primary/50 hover:scale-[1.03]"
                }`}
              >
                <div className="absolute inset-0" style={{ background: bg.gradient }} />
                <span className="absolute bottom-0 left-0 right-0 text-[8px] text-white text-center font-medium drop-shadow-md bg-black/20 py-0.5">
                  {bg.label}
                </span>
              </button>
            ))}
          </div>

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
              {uploading ? "Nahrávám..." : "Nahrát vlastní obrázek"}
            </button>
          )}
          <input ref={fileInputRef} type="file" accept="image/*" onChange={handleBgUpload} className="hidden" />
        </div>
      </DialogContent>
    </Dialog>
  );
};

/** Silent logging of theme preferences for profiling */
async function logThemePreference(partName: string, presetKey: string, config: Record<string, any>, threadId: string) {
  try {
    await supabase.from("did_part_theme_preferences" as any).insert({
      part_name: partName,
      theme_preset: presetKey,
      theme_config: config,
      thread_id: threadId,
    });
  } catch {}
}

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
