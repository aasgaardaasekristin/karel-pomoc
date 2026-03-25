import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Image, Loader2, MessageCircle, Minimize2, Moon, Pipette, RotateCcw, Save, Sparkles, Sun, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { type ThemePrefs, useTheme, hexToHSL, hslToHex, DEFAULT_PREFS } from "@/contexts/ThemeContext";

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

const PRESET_BACKGROUNDS = [
  { label: "Žádné", url: "", thumbnail: "" },
  { label: "Les", url: "https://images.unsplash.com/photo-1448375240586-882707db888b?w=1920&q=80", thumbnail: "https://images.unsplash.com/photo-1448375240586-882707db888b?w=200&q=60" },
  { label: "Jezero", url: "https://images.unsplash.com/photo-1439853949127-fa647821eba0?w=1920&q=80", thumbnail: "https://images.unsplash.com/photo-1439853949127-fa647821eba0?w=200&q=60" },
  { label: "Hory", url: "https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=1920&q=80", thumbnail: "https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=200&q=60" },
  { label: "Louka", url: "https://images.unsplash.com/photo-1500534314263-0869cef6150a?w=1920&q=80", thumbnail: "https://images.unsplash.com/photo-1500534314263-0869cef6150a?w=200&q=60" },
  { label: "Mlha", url: "https://images.unsplash.com/photo-1485236715568-ddc5ee6ca227?w=1920&q=80", thumbnail: "https://images.unsplash.com/photo-1485236715568-ddc5ee6ca227?w=200&q=60" },
  { label: "Západ slunce", url: "https://images.unsplash.com/photo-1495616811223-4d98c6e9c869?w=1920&q=80", thumbnail: "https://images.unsplash.com/photo-1495616811223-4d98c6e9c869?w=200&q=60" },
  { label: "Mlhovina", url: "https://images.unsplash.com/photo-1462331940025-496dfbfc7564?w=1920&q=80", thumbnail: "https://images.unsplash.com/photo-1462331940025-496dfbfc7564?w=200&q=60" },
  { label: "Noční obloha", url: "https://images.unsplash.com/photo-1519681393784-d120267933ba?w=1920&q=80", thumbnail: "https://images.unsplash.com/photo-1519681393784-d120267933ba?w=200&q=60" },
  { label: "Duha", url: "https://images.unsplash.com/photo-1507400492013-162706c8c05e?w=1920&q=80", thumbnail: "https://images.unsplash.com/photo-1507400492013-162706c8c05e?w=200&q=60" },
  { label: "Mandala", url: "https://images.unsplash.com/photo-1545048702-79362596cdc9?w=1920&q=80", thumbnail: "https://images.unsplash.com/photo-1545048702-79362596cdc9?w=200&q=60" },
  { label: "Textura", url: "https://images.unsplash.com/photo-1557682250-33bd709cbe85?w=1920&q=80", thumbnail: "https://images.unsplash.com/photo-1557682250-33bd709cbe85?w=200&q=60" },
];

interface ThemeEditorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  storageKey?: string;
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

function loadFromStorage(key: string): ThemePrefs {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return { ...DEFAULT_PREFS, ...JSON.parse(raw) };
  } catch {}
  return { ...DEFAULT_PREFS };
}

const ThemeEditorDialog = ({ open, onOpenChange, storageKey }: ThemeEditorDialogProps) => {
  const { prefs, presets, updatePrefs, uploadBackground, currentPersona, setCurrentPersona, applyTemporaryTheme } = useTheme();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);

  // If storageKey is provided, use localStorage; otherwise use DB via context
  const isLocalMode = !!storageKey;

  const [draft, setDraft] = useState<ThemePrefs>(() =>
    isLocalMode ? loadFromStorage(storageKey!) : prefs
  );

  useEffect(() => {
    if (isLocalMode) {
      setDraft(loadFromStorage(storageKey!));
    } else {
      setDraft(prefs);
    }
  }, [prefs, currentPersona, open, storageKey, isLocalMode]);

  const [storageVersion, setStorageVersion] = useState(0);
  const basePrefs = useMemo(() => isLocalMode ? loadFromStorage(storageKey!) : prefs, [isLocalMode, storageKey, prefs, storageVersion]);
  const hasPendingChanges = useMemo(() => JSON.stringify(draft) !== JSON.stringify(basePrefs), [draft, basePrefs]);

  const setDraftPartial = (partial: Partial<ThemePrefs>) => {
    setDraft((prev) => ({ ...prev, ...partial, persona: isLocalMode ? (storageKey || "local") : currentPersona }));
  };

  const handleApplyTheme = async () => {
    try {
      setSaving(true);
      if (isLocalMode) {
        // Save to localStorage and apply immediately
        localStorage.setItem(storageKey!, JSON.stringify(draft));
        applyTemporaryTheme(draft);
        toast.success("Vzhled použit");
      } else {
        await updatePrefs(draft);
        toast.success("Vzhled použit");
      }
    } catch (error: any) {
      toast.error(error?.message || "Nepodařilo se uložit vzhled");
    } finally {
      setSaving(false);
    }
  };

  const handleResetTheme = () => {
    if (isLocalMode) {
      setDraft(loadFromStorage(storageKey!));
    } else {
      setDraft(prefs);
    }
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-sm flex items-center gap-2">
            🎨 Nastavení vzhledu
          </DialogTitle>
          <DialogDescription className="text-xs">Personalizace barev, pozadí a písma{isLocalMode ? " pro tuto obrazovku" : " pro každou personu zvlášť"}.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Save/Reset bar */}
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

          {/* Persona selector - only in DB mode */}
          {!isLocalMode && (
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
          )}

          {/* Color presets */}
          <div>
            <p className="text-xs font-medium text-foreground mb-2">Barevné motivy</p>
            <div className="grid grid-cols-4 gap-1.5">
              {Object.entries(presets).map(([name, preset]) => (
                <button
                  key={name}
                  onClick={() => setDraftPartial({ primary_color: preset.primary_color!, accent_color: preset.accent_color!, theme_preset: name })}
                  className={`relative h-10 rounded-lg border-2 transition-all overflow-hidden ${draft.theme_preset === name ? "border-primary ring-1 ring-primary/30" : "border-border hover:border-primary/50"}`}
                >
                  <div className="absolute inset-0" style={{ background: `linear-gradient(135deg, hsl(${preset.primary_color}) 0%, hsl(${preset.accent_color}) 100%)` }} />
                  {draft.theme_preset === name && (
                    <div className="absolute inset-0 flex items-center justify-center">
                      <Check className="w-3.5 h-3.5 text-white drop-shadow-md" />
                    </div>
                  )}
                  <span className="absolute bottom-0.5 left-0 right-0 text-[8px] text-white text-center font-medium drop-shadow-md capitalize">{name}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Custom colors */}
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
                <button onClick={() => setDraftPartial({ font_color: "0 0% 20%" })} className="text-[9px] text-primary self-end hover:underline pb-1">+ barva písma</button>
              )}
            </div>
          </div>

          {/* Font family */}
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

          {/* Preview */}
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

          {/* Dark mode */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {draft.dark_mode ? <Moon className="w-3.5 h-3.5 text-primary" /> : <Sun className="w-3.5 h-3.5 text-primary" />}
              <span className="text-xs text-foreground">Tmavý režim</span>
            </div>
            <Switch checked={draft.dark_mode} onCheckedChange={(v) => setDraftPartial({ dark_mode: v })} />
          </div>

          {/* Font scale */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs text-foreground">Velikost písma</span>
              <Badge variant="outline" className="text-[9px] h-4 px-1.5">{Math.round(draft.font_scale * 100)}%</Badge>
            </div>
            <Slider value={[draft.font_scale]} min={0.8} max={1.3} step={0.05} onValueChange={([v]) => setDraftPartial({ font_scale: v })} />
          </div>

          {/* Border radius */}
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

          {/* Chat bubble style */}
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

          {/* Compact mode */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Minimize2 className="w-3.5 h-3.5 text-primary" />
              <span className="text-xs text-foreground">Kompaktní režim</span>
            </div>
            <Switch checked={draft.compact_mode} onCheckedChange={(v) => setDraftPartial({ compact_mode: v })} />
          </div>

          {/* Animations */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Sparkles className="w-3.5 h-3.5 text-primary" />
              <span className="text-xs text-foreground">Animace</span>
            </div>
            <Switch checked={draft.animations_enabled} onCheckedChange={(v) => setDraftPartial({ animations_enabled: v })} />
          </div>

          {/* Preset backgrounds */}
          <div>
            <p className="text-xs font-medium text-foreground mb-2">Připravená pozadí</p>
            <div className="grid grid-cols-4 gap-2">
              {PRESET_BACKGROUNDS.map((bg) => (
                <button
                  key={bg.label}
                  onClick={() => setDraftPartial({ background_image_url: bg.url })}
                  className={`relative rounded-lg border-2 overflow-hidden transition-all min-h-[60px] min-w-[80px] ${
                    draft.background_image_url === bg.url
                      ? "border-primary ring-1 ring-primary/30"
                      : "border-border hover:border-primary/50"
                  }`}
                >
                  {bg.thumbnail ? (
                    <img src={bg.thumbnail} alt={bg.label} className="w-full h-[60px] object-cover" loading="lazy" />
                  ) : (
                    <div className="w-full h-[60px] bg-muted flex items-center justify-center">
                      <X className="w-4 h-4 text-muted-foreground" />
                    </div>
                  )}
                  {draft.background_image_url === bg.url && (
                    <div className="absolute inset-0 flex items-center justify-center bg-black/20">
                      <Check className="w-4 h-4 text-white drop-shadow-md" />
                    </div>
                  )}
                  <span className="absolute bottom-0 left-0 right-0 text-[8px] text-white text-center font-medium drop-shadow-md bg-black/30 py-0.5">
                    {bg.label}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* Custom background upload */}
          <div>
            <p className="text-xs font-medium text-foreground mb-2">Vlastní pozadí</p>
            {draft.background_image_url && !PRESET_BACKGROUNDS.some(b => b.url === draft.background_image_url) ? (
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
      </DialogContent>
    </Dialog>
  );
};

export default ThemeEditorDialog;
