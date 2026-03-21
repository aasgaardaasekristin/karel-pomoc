

# Implementace: Progress bar pro dlouhoběžící operace

## Ověřeno
- `loading` a `refreshing` jsou oddělené boolean stavy ✅
- `overview` začíná jako `""` (ne `null`) — podmínka `loading && !overview` funguje správně ✅
- `primary` v Tailwind je `hsl(var(--primary))` — opacity varianty fungují ✅

## 3 soubory, ~35 řádků

### 1. `src/index.css` — vložit za řádek 197 (po `.login-card` bloku, před uzavírací `}`)

Přidat keyframes animaci pro indeterminate progress bar.

### 2. `src/components/did/DidSprava.tsx` — nahradit ToolButton (ř. 456–477)

- `flex-col` layout pro progress bar pod textem
- Podmíněný `border-primary/30 bg-primary/5 cursor-wait` při loading
- Text "Probíhá..." místo popisu
- Indeterminate progress bar (1px výška, `overflow-hidden`)

### 3. `src/components/did/DidSystemOverview.tsx` — nahradit ř. 136–144

- Progress bar viditelný při loading i refresh
- Initial load: spinner + text + progress bar
- Refresh: obsah zůstává viditelný (`opacity-60`), žádný content flash

Žádná logika se nemění. Čistě vizuální.

