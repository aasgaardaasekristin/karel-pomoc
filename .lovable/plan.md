

# Plán: Jungova pracovna (CSS fix) + Banner dedup + Kouzelnický motiv + Karlův přehled

## Problém 1: Jungova pracovna neviditelná

**Příčina potvrzena**: `ThemeContext` (řádek 412-418) nastavuje CSS proměnné přes `root.style.setProperty()` — tj. inline styly na `<html>`. Inline styly mají absolutně nejvyšší specificitu a přebijí jakýkoli CSS class včetně `.jung-study`. Řešení přes `!important` v CSS tuto specificitu nepřebije, protože inline style + `!important` na straně root vyhrává.

**Skutečné řešení**: V `DidContentRouter` při `didFlowState === "terapeut"` přeskočit `applyTemporaryTheme` a místo toho přímo nastavit jung-study proměnné přes `document.documentElement.style.setProperty`. Konkrétně:
- Vytvořit funkci `applyJungStudyTheme()` v `DidContentRouter.tsx` která nastaví všech ~30 CSS vars přímo na root element (stejný mechanismus jako ThemeContext, ale s jung hodnotami)
- Zavolat ji v `useEffect` když `didFlowState === "terapeut" && !didSubMode`
- Při opuštění zavolat `restoreGlobalTheme()`

Jemná paleta (žádné křiklavé barvy):
```
--background: 34 28% 94%    (teplý pergamen)
--foreground: 28 18% 18%    (tmavě hnědá, ne černá)
--card: 36 24% 91%          (jemně světlejší pergamen)
--primary: 28 32% 38%       (teplá ořechová)
--accent: 24 26% 48%        (jemná karamelová)
--muted: 34 18% 88%         (tlumený písek)
```

Mandala a částice: zachovat, ale snížit opacity na 0.04-0.07 a animaci zpomalit na 40s+ (aktuálně 25s). Barvy částic jen v rozsahu hsl(28-38, 30-45%, 55-62%) — žádná zlatá ani zářivá.

**Soubory**: `src/components/did/DidContentRouter.tsx`, `src/index.css`

## Problém 2: Banner duplikace

`mainBlocker` (řádek 362-363) stále vrací "Chybí dnešní Karlův krizový rozhovor" a "Čeká se na feedback terapeutek" — to jsou přesně ty samé stavy co se zobrazují jako badge "chybí: interview" a "chybí: feedback" v řádku 1 banneru. Výsledek: 3× totéž.

**Řešení**: V `computeMainBlocker` přeskočit `missingTodayInterview` a `missingTherapistFeedback` — ty jsou pokryty badges a CTA. Blocker bude ukazovat jen skutečné další blokace.

```typescript
function computeMainBlocker(card): string | null {
  // Skip interview/feedback — covered by badges + CTAs
  if (card.missingSessionResult) return "Chybí výsledek sezení";
  if ((card.unansweredQuestionCount ?? 0) > 0) return `${card.unansweredQuestionCount} nezodpovězených otázek`;
  if (card.crisisMeetingRequired && !card.meetingOpen) return "Porada doporučena";
  if (card.isStale && (card.hoursStale ?? 0) > 48) return "Nutný update";
  return null;
}
```

**Soubor**: `src/hooks/useCrisisOperationalState.ts`

## Problém 3: Kouzelnický motiv pro DID/Kluci

Nový preset `wizarding` v ThemeContext:
- Temně modrá `220 28% 16%` (noční nebe, ne křiklavá)
- Zlatá jemná `38 32% 52%` (ne zářivá, spíš staré zlato)
- Akcent: `260 18% 48%` (tlumená fialová, mystická)

Nová CSS třída `.wizarding-world` s:
- Jemné hvězdy (radial-gradient body s opacity 0.15-0.25)
- Pomalá animace 60s
- Žádné ostré barvy, vše v psychologicky uklidňujících tónech

Automaticky aplikovat v `DidContentRouter` když `didSubMode === "cast"` a není nastaveno vlastní téma vlákna.

**Soubory**: `src/contexts/ThemeContext.tsx`, `src/index.css`, `src/components/did/DidContentRouter.tsx`

## Problém 4: Karlův přehled — přepis na narativní monolog

Kompletní přepis `KarelDailyPlan.tsx`:

Místo 4 suchých bloků (Urgentní / Sezení / Úkoly / Otázky) → narativní Karlův monolog s interaktivními odkazy:

1. **Oslovení** — "Dobré ráno, Haničko." (podle denní doby)
2. **3-denní retrospektiva** — s kým Karel mluvil, co zjistil, jaká rozhodnutí udělal (z DB: `crisis_karel_interviews`, `did_threads`, `crisis_daily_assessments`)
3. **Návrh sezení** — klikatelný odkaz na plán 60min sezení (z `did_daily_session_plans`)
4. **Nesplněné úkoly** — s přímým odkazem kam odpovědět (z `did_therapist_tasks`)
5. **Nezodpovězené otázky** — s přímým odkazem (z `did_pending_questions`)
6. **Hodnocení spolupráce** — jemná motivace nebo výtka, ale pozitivně laděná
7. **Nabídka pomoci** — "Potřebuješ pomoct?" → klik otevře nové vlákno s Karlem
8. **Vstupní pole** — terapeutka může Karlovi napsat vzkaz přímo z přehledu

Každý bod bude mít vizuální styl jung-card, jemné barvy, serif nadpisy. Žádné ostré barevné odlišení — jen jemné levé ohraničení v tlumených tónech (hsl 28 20% 72%).

**Soubor**: `src/components/did/KarelDailyPlan.tsx`

## Pořadí implementace

1. Jung vizuál — přímé CSS vars přes JS (okamžitě viditelné)
2. Banner dedup — computeMainBlocker skip
3. Kluci kouzelnický motiv
4. Karlův přehled přepis

## Vizuální pravidla (průřezová)

- Žádné křiklavé barvy nikde v aplikaci
- Maximální saturace 35% pro pozadí, 45% pro akcenty
- Animace pomalé (40s+), opacity pod 0.1
- Mandala jen jako jemný watermark, nikdy dominantní
- Barvy vždy v psychologicky uklidňujícím spektru (teplé zemité, tlumené modré/fialové)

