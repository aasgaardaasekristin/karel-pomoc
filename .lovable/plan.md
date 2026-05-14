
# Vrstva „Herna – [jméno části]" — schvalovací rámec ve 3 blocích

Schváleno jako rámec. Tato verze obsahuje 3 dohodnuté úpravy:
- BLOK 1: žádný placeholder pro „Diagnostické uzly" — sekce se v BLOKU 1 **vůbec nerenderuje**, přidá se až s BLOKEM 3.
- BLOK 2: Perplexity **mimo scope** této iterace (default `external_context_used=false`).
- BLOK 2: gate je definován jako **kombinace** canonical snapshot + WM freshness + pipeline health (ne jen „dnešní snapshot_key").

**Approval režim per blok (nahrazuje původní jednotnou formulaci):**
- **BLOK 1:** po „ANO BLOK 1" jdu **rovnou do implementace** (frontend-only).
- **BLOK 2 a BLOK 3:** po „ANO BLOK N" nejdřív **detailní technický brief** (migrace, edge function signatures, gate kontrakt, prompt struktura) a teprve po jeho schválení kód.

---

## Co je potvrzená pravda dnes (z kódu + minulých iterací)

- Karta dnes v `src/components/did/PlayroomDecisionCard.tsx`, mountovaná z `DidDailyBriefingPanel.tsx`. Header „Plán dnešní herny".
- Sekce 8–11 (program, pre-approval otázky, post-session) jsou už pod tlačítkem „Otevřít poradu ke schválení Herny" → **zůstává** jako zanořená podvrstva.
- DB `did_daily_session_plans.urgency_breakdown.playroom_plan` může obsahovat `opening_monologue`, `last_session_summary`, `deductions`, `direction`, `therapist_actions`, `pre_approval_questions`. Pavoučí uzly v datech **neexistují**.
- WM snapshot existuje (`karel_working_memory_snapshots`, edge `karel-wm-inspect`). Frontend dnes WM jako preflight gate **nečte**.
- Generátor: `supabase/functions/_shared/playroomGroundedPlan.ts` (volaný z `karel-did-auto-session-plan`). Perplexity v něm dnes **není**.

---

## BLOK 1 — UI shell vrstvy „Herna" (frontend-only)

**Co dělám:**

1. **Rename:** header karty „Plán dnešní herny" → „**Herna – [jméno části]**" (dynamicky z `playroomProposal.partName`). Sjednotit ve všech místech (`PlayroomDecisionCard`, `DidDailyBriefingPanel`, případné odkazy/labely).
2. **Restrukturace hlavní plochy** (pořadí sekcí):
   - **Karlova promluva** — read-only, čte `playroom_plan.opening_monologue`. Žádné editace, žádný textarea, žádná syntéza ze sekcí. Pokud chybí → honest empty state „Karlova promluva pro tuto hernu zatím nebyla vygenerována." (jediná povolená výjimka — Karlova promluva má smysl jako honest empty state).
   - **Co víme z poslední herny** — 4 bloky (proběhlo / neproběhlo / fungovalo / destabilizovalo). Render jen pokud má data.
   - **Pracovní dedukce** — 3 boxy (potvrzená fakta / hypotézy / nejasné). Render jen pokud má data.
   - **Dnešní směr práce** (fáze, readiness, hlavní/vedlejší cíl, co dnes nedělat, kontraindikace, stop pravidla, fallback). Render jen pokud má data.
   - **Tlačítko „Otevřít poradu ke schválení herny"** → existující zanořená podvrstva (program, pre-approval, post-session).
   - **Sekce „Diagnostické uzly" se v BLOKU 1 vůbec nerenderuje.** Přidá se až BLOKEM 3, kde má vlastní workflow.
3. **Pravidlo prázdných sekcí:** sekce se nezobrazí samostatně, pokud pro ni neexistuje plnohodnotný workflow contract / data. Žádné mrtvé „chybí podklad" placeholdery (s jednou výjimkou — viz Karlova promluva výše).
4. **Audit zakázaných frází** napříč produkčním renderem této karty: smazat zbytky „grounded", „čerpá ze skutečných dat", „source_status", „quality_score", „render path", „Lidský návrh k poradě", „Podklad pro plánování" pokud kde zbyly.

**Co BLOK 1 NEDĚLÁ:** žádné WM gating, žádné volání `karel-wm-inspect`, žádný nový generátor, žádná Perplexity, žádné pavoučí uzly (ani placeholder).

**Soubory:** `src/components/did/PlayroomDecisionCard.tsx`, případně 1řádkový rename v `DidDailyBriefingPanel.tsx`.

**Acceptance, které BLOK 1 splní:** rename, struktura, žádné zakázané fráze, žádné fabrikování promluvy, žádné mrtvé placeholdery.
**Acceptance, které NESPLNÍ:** Karlova promluva ve vzorovém tónu (BLOK 2), pavoučí nohy (BLOK 3), gating (BLOK 2).

---

## BLOK 2 — Backend gating + generátor Karlovy promluvy

**Po „ANO BLOK 2" nejdřív detailní technický brief, kód až po jeho schválení.**

**Co dělám:**

1. **Preflight gate** (sdílený helper, server + frontend mirror) — kombinace tří signálů:
   - **Canonical snapshot:** existuje dnešní `did_daily_context.context_json` a obsahuje validní `canonical_*` bloky (primární denní normalizovaný read model).
   - **WM freshness:** poslední `karel_working_memory_snapshots.snapshot_key = today` **nebo** explicitně poslední validní WM snapshot s `degraded_sources`/`stale_sources` bez kritických zdrojů.
   - **Pipeline health:** poslední `karel_daily_cycle_runs` = dnes, status `completed`, žádný kritický job ve `failed`.
   - Kontrakt vrátí `{ ok: true }` **nebo** `{ blocked: true, mode: 'hard'|'downgraded', reason, missing[] }`.
   - **Hard block:** chybí canonical snapshot nebo pipeline health. Generátor neukládá nic, vrací chybu.
   - **Downgraded mode:** canonical snapshot OK + pipeline OK, ale WM stale/missing. Otázka pro brief: zda v downgraded režimu povolit generování bez WM (s explicitním auditem `wm_used=false`), nebo i to blokovat. **Default návrh: downgraded = block** (radši žádná promluva než promluva bez operativní vrstvy).
2. **Úprava `playroomGroundedPlan.ts`:**
   - Před AI voláním zavolá gate. Když blokováno → neukládá nic, vrací strukturovanou chybu.
   - Prompt pro `opening_monologue` přepsán podle vzoru (Tundrupek): oslovení + 3–7 destilátových bulletů + odborné formulace s explicitním oddělením fakt/hypotéz + dnešní východiska + výčet diagnostických otázek (max 6, bez rozepsaných odpovědí — ty se stanou pavoučími nohami v BLOKU 3) + 1 závěrečná věta.
   - Vstupy do promptu: dnešní WM snapshot + canonical snapshot + herna data + last 1–2 sezení + relevantní Drive dokumenty (00Dashboard / 05A / 05C / karta části) + analýza včerejších vláken.
3. **Externí inteligence (Perplexity) — MIMO SCOPE této iterace.** Audit pole `external_context_used=false` zůstává jako placeholder pro budoucí samostatný ticket. Důvod: research integration je oddělená smyčka, ne součást každého denního generování; první bezpečný slice ji nezahrnuje.
4. **Audit / persistence:** `did_daily_session_plans.meta.generation_audit = { used_sources[], blocked_by, external_context_used: false, wm_snapshot_id, canonical_snapshot_at, pipeline_run_id }`. Žádné nové tabulky.
5. **UI chování při blocked:** karta ukáže Karlovi/adminovi technický blok „Generování blokováno: [důvod]. Spustit recovery cyklus." (volá existující recovery edge). **Nikdy** nesyntetizuje falešnou promluvu.

**Otevřené otázky pro brief:**
- B2-Q1: Downgraded mode (canonical+pipeline OK, WM stale) — **block**, nebo **allow s auditem**? Default: block.
- B2-Q2: „Pipeline health" definice — stačí `karel_daily_cycle_runs.status='completed'`, nebo navíc kontrolovat konkrétní kritické phase jobs? Default: oboje.
- B2-Q3: Recovery tlačítko v blocked stavu — která existující edge? (Ověřím v briefu.)

---

## BLOK 3 — Pavoučí nohy (nová doména) + zpětná pipeline

**Po „ANO BLOK 3" nejdřív detailní technický brief, kód až po jeho schválení.**

**Sémantika:** pavoučí uzly **nejsou** „denní pozorování" ani „pending questions". Jsou to **persistent diagnostické pracovní objekty** s vlastním životním cyklem (open → answered → integrated), strukturovaným dialogem mezi Karlem / Hanou / Káťou, a zpětným writebackem do canonical sources / WM. Proto **samostatná tabulka**, ne rozšíření `did_pending_questions` (které jsou jednorázové workflow položky pro schválení programu).

**Co dělám:**

1. **Migrace** — nová tabulka `did_playroom_diagnostic_nodes`:
   - `id, plan_id (FK did_daily_session_plans), part_name, node_type ('karel_question'|'therapist_reaction'|'moment'|'anamnestic_question'), title, karel_context (text), status ('open'|'answered'|'integrated'), created_at, updated_at, integrated_at, user_id`.
   - Související `did_playroom_diagnostic_node_messages` (id, node_id, author ('karel'|'hana'|'kata'), body, created_at). Strukturovaný dialog, ne volný chat.
   - RLS: jen pro vlastníka.
2. **UI — pavouček v hlavní ploše „Herna":**
   - Sekce „Diagnostické uzly" zobrazí seznam karet/řádků (ikona + název podle `node_type`).
   - Klik → sub-surface s Karlovým kontextem nahoře, structured dialog dole, tlačítko „označit zodpovězeno".
   - Možnost terapeutek založit vlastní uzel `therapist_reaction` (s výběrem hypotézy z promluvy).
3. **Generátor → uzly:** `playroomGroundedPlan.ts` po vygenerování promluvy automaticky založí `karel_question` uzly z výčtu diagnostických otázek (1 otázka = 1 uzel). Idempotent na hash titulu (žádné duplikáty při re-generaci).
4. **Nightly zpětná pipeline:** nová edge `karel-playroom-nodes-integrate` (cron, denně po nightly cyklu):
   - Načte uzly se změnami za 24h.
   - AI klasifikace odpovědí: `confirmed_fact | new_hypothesis | refined_hypothesis | still_open`.
   - Zpětný writeback do canonical sources / WM přes existující memory orchestration pipeline; markne `status='integrated'`, `integrated_at=now()`.
   - Logy v `did_pipeline_runs`.

**Otevřené otázky pro brief:**
- B3-Q1: Mají terapeutky moct zakládat **všechny** typy uzlů, nebo jen `therapist_reaction` a `moment`? Default: jen tyto dva (Karel jako jediný zakládá `karel_question` a `anamnestic_question`).
- B3-Q2: „Reakce na hypotézu" — výběr ze seznamu hypotéz extrahovaných z promluvy (vyžaduje, aby generátor v BLOKU 2 hypotézy explicitně otaguje `hypothesis_id`). Potvrdit, že to do BLOKU 2 promptu zapracujeme.
- B3-Q3: Re-open integrated uzlu — povoleno, nebo zamčeno? Default: zamčeno, nový uzel s referencí na předchozí.

---

## Čekám na

- **„ANO BLOK 1"** → jdu rovnou do kódu (frontend-only).
- nebo **„ANO BLOK 2"** / **„ANO BLOK 3"** → nejdřív napíšu detailní technický brief, kód až po jeho schválení.
- nebo **úpravy scope.**

Bloky 2 a 3 zůstávají pod backend freeze, dokud nepustíš jejich brief.
