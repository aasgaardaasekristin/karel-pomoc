Odpověď na otázku: neudělal jsem to správně proto, že jsem poslední implementaci soustředil na oddělení Herny a zastavení míchání Herna programu se Sezením. V kódu sice existuje render sekce pro včerejší sezení, ale je pojmenovaný a koncipovaný jako „Vyhodnocení včerejšího sezení“, ne jako samostatná explicitní sekce „Včerejší sezení“ podle tvé vize. Navíc dnešní briefing v databázi má `yesterday_session_review.held=false`, i když pro včerejšek existuje jeden review záznam a pět plánů; tím pádem se sekce v UI nespustí. To je přesně ta mezera: backend enrichment nepřebíjí prázdný/false payload dostatečně tvrdě a UI nemá samostatný blok „Včerejší sezení“ jako paralelu k „Včerejší herna“.

Opravím to takto:

1. V Karlově přehledu budou dvě oddělené včerejší sekce

```text
Včerejší herna
- Karel-led přímý kontakt s dítětem/částí
- praktický report Herny
- význam pro část
- doporučení pro další Hernu
- detailní analýza Herny, pokud existuje

Včerejší sezení
- terapeutkou vedené sezení
- co se fakticky stalo / jaký je stav evidence
- Karlovo klinické přetlumočení
- co teď víme o části
- co z toho plyne pro další terapeutický plán
- týmové uzavření
- detailní analýza sezení, pokud existuje
```

Nebude to jedna sloučená sekce a nebude se to jmenovat pouze „Vyhodnocení včerejšího sezení“. „Vyhodnocení“ bude podčást uvnitř „Včerejší sezení“.

2. Zpřísním backend Karlova přehledu

V `karel-did-daily-briefing` upravím logiku `enrichYesterdaySessionReview` tak, aby:

- za včerejší sezení považovala primárně non-playroom terapeutické review z `did_session_reviews`, i když neexistuje řádek v `did_part_sessions`,
- neignorovala review jen proto, že evidence basis vyjde jako `unknown`,
- pokud existuje non-playroom review pro včerejší plán, payload bude mít `held=true` nebo alespoň evidence-limited stav, který UI zobrazí,
- AI payload s `held=false` nesmí přebít databázově doložené včerejší review/sezení,
- playroom review zůstane oddělené a nikdy nebude použité jako náhrada sezení.

3. Zpřísním UI fallback v `DidDailyBriefingPanel.tsx`

Upravím načítání včerejších fallbacků tak, aby:

- `Včerejší sezení` naskočilo vždy, když existuje non-playroom `did_session_reviews` nebo včerejší terapeutický plán se stopou review/progress,
- prázdný payload `held:false` z briefingu neskryl reálný fallback z databáze,
- názvy podsekcí jasně rozlišily faktický stav od klinického vyhodnocení,
- Herna fallback už při chybějícím sezení nesmazal omylem session fallback a naopak.

4. Doplním konzistentní slovník

V UI bude:

- sekce: `Včerejší herna`
- sekce: `Včerejší sezení`
- uvnitř sezení podčást: `Karlovo vyhodnocení`
- žádné splývání Herny se Sezením
- žádné používání playroom programu nebo playroom review jako terapeutického session review

5. Ověření po implementaci

Po schválení provedu:

- TypeScript build,
- kontrolu, že dnešní briefing umí zobrazit včerejší session review i při `held=false` v uloženém payloadu,
- kontrolu, že `Včerejší herna` a `Včerejší sezení` jsou dvě samostatné sekce,
- kontrolu, že backend prompt/enrichment neumožní tiché zmizení sekce, pokud existuje databázový doklad včerejšího sezení/review.

Dotčené soubory:

- `supabase/functions/karel-did-daily-briefing/index.ts`
- `src/components/did/DidDailyBriefingPanel.tsx`

Výsledek:

Karlův přehled bude mít vedle samostatné sekce pro včerejší Hernu také samostatnou sekci `Včerejší sezení`, přesně oddělenou od Herny i od dnešního programu.