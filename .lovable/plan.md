

# Fáze 5: End-to-End Integrace a Validace

## Přehled

Poslední fáze propojí pipeline data s Karlovým kontextem, nastaví cron pro weekly-review a přidá monitoring. Karel už čte `did_daily_context` v `karel-chat/index.ts` (řádky 23-100) — potřebujeme rozšířit `karel-daily-refresh` o pipeline data a přidat instrukce do system promptu.

---

## Krok 1: Rozšířit `karel-daily-refresh` o pipeline kontext

**Soubor:** `supabase/functions/karel-daily-refresh/index.ts`

Za existující DB queries (řádek ~196), přidat 4 nové paralelní dotazy:
- `did_plan_items` (05A, active, limit 15)
- `did_pending_questions` (open, limit 10)
- `did_profile_claims` (active, limit 30)
- `did_observations` (active, last 48h, limit 15)

Do `contextJson` (řádek ~218) přidat nové sekce:
- `pipeline.plan_items_05A` — operativní plán
- `pipeline.open_questions` — otevřené otázky
- `pipeline.recent_observations` — nedávná pozorování
- `pipeline.active_claims_summary` — shrnutí aktivních claims per part

---

## Krok 2: Rozšířit kontext injekci v `karel-chat/index.ts`

**Soubor:** `supabase/functions/karel-chat/index.ts` (řádky 50-94)

Po existujících blocích (driveBlock), přidat rendering nových pipeline dat z `ctx.pipeline`:
- `planBlock` — formátuje plan_items_05A s prioritami
- `questionsBlock` — formátuje open_questions
- `observationsBlock` — formátuje recent_observations s evidence labels
- `claimsBlock` — formátuje claims pro aktuální část (pokud známe `partName` z konverzace)

Přidat `PIPELINE_INSTRUCTIONS` konstantu s pravidly pro Karla (jak používat ✅/❓/🔴 data, co neříkat).

---

## Krok 3: Cron job pro `karel-weekly-review`

SQL insert (ne migrace) pro pg_cron:
```
cron.schedule('weekly-review', '0 20 * * 0', ...)
```
Neděle 20:00 UTC. Ověřit že existující cron jobs pro daily-cycle a crisis-retroactive-scan jsou aktivní. Přidat komentář do `config.toml`.

---

## Krok 4: Pipeline health check v `karel-did-daily-cycle`

**Soubor:** `supabase/functions/karel-did-daily-cycle/index.ts`

Před trigger karel-daily-refresh (řádek ~5156), přidat health check blok:
- Count active observations, claims, plan_items, open questions
- Warn pokud 0 observations za 48h
- Log summary

---

## Krok 5: Dokumentace

**Nový soubor:** `docs/PIPELINE_ARCHITECTURE.md`

Strukturovaný markdown popis celé 5-fázové pipeline:
- Diagram toku (observation → implication → plan_item / profile_claim)
- Tabulky a jejich role
- Cron schedule
- Evidence levels a routing pravidla

---

## Krok 6: End-to-end test

Po implementaci:
1. Insert testovacích dat (observation + plan_item + pending_question)
2. Invoke `karel-daily-refresh` → ověřit pipeline sekce v context_json
3. Invoke `update-part-profile` s test claimem
4. Invoke `karel-weekly-review` → ověřit stats
5. Cleanup testovacích dat

---

## Pořadí implementace

1. `karel-daily-refresh` — pipeline queries + context enrichment
2. `karel-chat/index.ts` — pipeline rendering + PIPELINE_INSTRUCTIONS
3. `karel-did-daily-cycle` — health check
4. Cron job SQL insert pro weekly-review
5. `docs/PIPELINE_ARCHITECTURE.md`
6. Config.toml komentáře
7. End-to-end test + cleanup

## Technické poznámky

- `karel-chat` už ví `partName` z konverzace (mode context) — použijeme pro filtrování claims
- Pipeline kontext se PŘIDÁVÁ k existujícím Drive dokumentům, nenahrazuje je
- Celková velikost context_json se zvýší o ~2-4KB — v limitu

