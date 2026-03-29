

## Problém

Screenshot ukazuje taby v dialogu "Správa" kde:
- Emoji ikony zabírají místo a tlačí text
- Slova se lámou uprostřed (Bez-peč-nost, Ná-stroje, Kar-toté-ka, Po-znám-ky, Tren-dy, Zdra-ví, Re-porty, Vzle-d)
- `flex-1` nutí všechny taby mít stejnou šířku → příliš úzké

## Řešení

### Soubor: `src/components/did/DidSprava.tsx` (řádky 164–188)

**Změny:**

1. **Odstranit emoji** ze všech tab labels — ponechat jen text
2. **Zrušit `flex-1`** → taby budou mít auto-šířku podle obsahu
3. **Přidat `whitespace-nowrap`** — zakáže lámání slov
4. **Zmenšit font na `text-[10px]`** a padding na `px-2 py-1`

**Před:**
```tsx
<div className="flex gap-1 mb-3 p-0.5 rounded-lg bg-muted flex-wrap">
  { key: "safety", label: "🚨 Bezpečnost..." },
  { key: "tools", label: "🛠 Nástroje" },
  ...
  className={`flex-1 text-xs py-1.5 rounded-md ...`}
```

**Po:**
```tsx
<div className="flex gap-1 mb-3 p-1 rounded-lg bg-muted flex-wrap">
  { key: "safety", label: newAlertCount > 0 ? `Bezpečnost (${newAlertCount})` : "Bezpečnost" },
  { key: "tools", label: "Nástroje" },
  { key: "plan", label: "Plán" },
  { key: "kartoteka", label: "Kartotéka" },
  { key: "memory", label: "Paměť" },
  { key: "notes", label: "Poznámky" },
  { key: "trends", label: "Trendy" },
  { key: "goals", label: "Cíle" },
  { key: "health", label: "Zdraví" },
  { key: "registry", label: "Registr" },
  { key: "reports", label: "Reporty" },
  { key: "cleanup", label: "Cleanup" },
  { key: "theme", label: "Vzhled" },
  ...
  className={`px-2 py-1 text-[10px] whitespace-nowrap rounded-md ...`}
```

Jeden soubor, jeden blok změn (~25 řádků).

