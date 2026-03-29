

## Oprava: "Dokument bez názvu" a nefunkční týdenní aktivita

### Problém 1: "Dokument bez názvu"
Toto se zobrazuje jako titulek stránky v prohlížeči — `index.html` má `<title>Lovable App</title>`, ale uživatel pravděpodobně vidí "Dokument bez názvu" jako text v dashboardu pocházející z thread_label fallbacku v jiné komponentě, nebo z Google Drive dat zobrazených v přehledu. Potřebuji ověřit screenshotem, co přesně uživatel vidí.

**Akce:** Změnit `<title>` na "Karel — DID Asistent" a prověřit, zda se "bez názvu" zobrazuje někde v UI dashboardu.

### Problém 2: Týdenní aktivita — prázdný graf
Sekce 6 (ř. 648-661) zobrazuje sloupce na základě `daily_metrics`. Pokud tabulka nemá data (což je pravděpodobné — metrika se plní edge funkcí `compute-daily-metrics`), zobrazí se jen prázdné sloupce s písmenky PÚSČPSN a nic užitečného.

**Akce:**
1. Pokud `weekActivity` má VŠECHNY hodnoty 0 → **skryj celou sekci** (stejně jako heatmapa se skrývá při `length === 0`)
2. Alternativně: spadni na počítání zpráv z `did_threads` místo `daily_metrics`, aby graf měl reálná data

### Plán změn

**Soubor 1: `index.html`**
- Změnit `<title>` na "Karel — DID Asistent"

**Soubor 2: `src/components/did/DidDashboard.tsx`**
- Sekce 6: přidat podmínku `weekActivity.some(([, c]) => c > 0)` — pokud jsou všechny hodnoty 0, sekci nezobrazovat
- Alternativně: fallback na počítání zpráv z threadů pokud daily_metrics nemá data

**Soubor 3: Ověření "dokument bez názvu"**
- Prověřit screenshot, co konkrétně uživatel vidí — jestli jde o titulek stránky, nebo obsah generovaný AI (z thread_label fallbacku)

