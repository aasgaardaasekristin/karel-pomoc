# Plán: Oprava perzistence "Krizový plán pro Arthura" + ochrana všech klikatelných položek z Karlova přehledu

> **Verze 2** — zapracované 3 korekce uživatele před implementací.
> Status: **ČEKÁ NA SCHVÁLENÍ.** Žádný kód neměnit, dokud uživatel nepotvrdí.

## A. Root cause (potvrzeno z DB)

Karlův přehled → "Krizový plán pro Arthura" → klik:

1. `DidDailyBriefingPanel.openDecisionDeliberation()`
2. → POST `karel-team-deliberation-create` s `linked_briefing_item_id = '5dde49c1-3f68-4a96-a641-d8d122e20cda'`
3. → server idempotence lookup filtruje `status IN (draft|active|awaiting_signoff)` — **`approved` se přeskočí**
4. → unique index `uniq_did_team_delib_active_briefing_item` má stejný WHERE filter → `approved` ho neblokuje
5. → INSERT projde, **vznikne nová prázdná porada `a57cbd2b…`**
6. → UI ji otevře jako úplně novou (žádné odpovědi, žádné podpisy, Karel blocked)

**DB důkaz aktuálního stavu:**

| linked_briefing_item_id | id | status | qh | hs/ks/krs | poznámka |
|---|---|---|---|---|---|
| `5dde49c1…` (Arthur krize) | `8ac5d27a…` | approved | 3 | ✅✅✅ | původní podepsaná |
| `5dde49c1…` (Arthur krize) | `a57cbd2b…` | active | 3 | ❌❌❌ | **duplicitní prázdná, otevírá se v UI** |
| `4fe3b11d…` (Arthur supervize) | `65cb2d6e…` | active | 3 | ❌❌❌ | rozpracovaná, OK (žádný duplikát) |
| `a3ecbedb…` (Arthur+Říha) | `9aa036e8…` | active | 3 | ❌❌❌ | rozpracovaná, OK (žádný duplikát) |

## B. Řešení (zapracované korekce)

### B1. Reuse logika — kanonická, BEZ filtru na den (korekce 1)

V `karel-team-deliberation-create` změnit lookup na **dvoukrokovou kaskádu** podle čistě `linked_briefing_item_id` (žádný date filter):

1. Najdi `draft|active|awaiting_signoff` pro daný `(user_id, linked_briefing_item_id)` → otevři ji.
2. Jinak najdi `approved` pro daný `(user_id, linked_briefing_item_id)` → otevři ji **read-only** (klient pozná podle `status`).
3. Jinak → INSERT (nová porada).

`closed`/`archived` zůstávají mimo reuse — terapeutka je explicitně uzavřela, nový thread je správně.

`linked_briefing_item_id` je sám o sobě stabilním identifikátorem konkrétního briefing rozhodnutí. Žádný "dnešní den" filter nepotřebuju.

### B2. Race-protect přes unique index (rozšíření whitelistu o `approved`)

Stávající:
```sql
WHERE status IN ('draft','active','awaiting_signoff')
```
Nový:
```sql
WHERE status IN ('draft','active','awaiting_signoff','approved')
```

DROP starého indexu → CREATE nového. Konkurenční INSERT po `approved` selže s 23505, server-side handler vrátí existující approved poradu místo 500.

### B3. Read-only banner v `DeliberationRoom`

Když `d.status === 'approved'`:
- horní banner "✅ Tato porada je už schválená — otevíráš ji jen pro náhled."
- zneaktivnit: textarea pro odpovědi, tlačítka Podepsat, tlačítko Spustit syntézu, input pro discussion.
- vše ostatní (Karlova syntéza, final_summary, podpisové timestampy, agenda, otázky) zůstává viditelné.

### B4. Cleanup duplicit — repair krok, NE inline produkční IDs (korekce 2)

**Idempotentní data-repair SQL** (přes `insert` tool, ne migration), který:

1. **Before audit query** — vypíše všechny `linked_briefing_item_id`, kde existuje řádek se status `approved` AND zároveň ≥1 řádek se status `draft|active|awaiting_signoff`.
2. **Repair** — `DELETE FROM did_team_deliberations WHERE` …
   - status ∈ (draft|active|awaiting_signoff)
   - AND existuje sibling se stejným `linked_briefing_item_id` se status=approved
   - AND tento řádek nemá žádný podpis (`hanka_signed_at IS NULL AND kata_signed_at IS NULL AND karel_signed_at IS NULL`)
   - AND nemá žádný diskusní vstup (`jsonb_array_length(discussion_log) = 0`)
   - AND nemá Karlovu syntézu (`karel_synthesis IS NULL`)
3. **After audit query** — vrátí 0 řádků (potvrzení čistoty).

**Žádné natvrdo zapsané `8ac5d27a…` nebo `a57cbd2b…`.** Selektor je čistě "duplikát ve stejné skupině s prázdným obsahem". Bezpečné spustit i opakovaně.

Pokud by aktivní duplikát měl jakoukoliv práci (podpis / log / syntéza), repair se ho NEDOTKNE a uživatel dostane warning v after-auditu. To řeším ručně, ne automaticky.

### B5. Mapa dotčených klikatelných položek (korekce 3)

#### Karlův přehled — Karlovy denní briefing karty

| Karta v UI | Source pole | Click handler | Volá `karel-team-deliberation-create`? | Bug se projeví? |
|---|---|---|---|---|
| **Plán sezení** (`proposed_session`) | `briefing.proposed_session` | `openProposedSessionDeliberation` | ✅ ano (`type=session_plan`) | ✅ **ANO** — fix se projeví |
| **Rozhodnutí: Krizová porada** (`decisions[type=crisis]`) | `briefing.decisions[i]` | `openDecisionDeliberation` | ✅ ano (`type=crisis`) | ✅ **ANO** — Arthur case |
| **Rozhodnutí: Klinické** (`decisions[type=clinical]`) | `briefing.decisions[i]` | `openDecisionDeliberation` | ✅ ano (`type=team_task`) | ✅ **ANO** |
| **Rozhodnutí: Supervize** (`decisions[type=supervision]`) | `briefing.decisions[i]` | `openDecisionDeliberation` | ✅ ano (`type=supervision`) | ✅ **ANO** |
| **Rozhodnutí: Followup review** (`decisions[type=followup_review]`) | `briefing.decisions[i]` | `openDecisionDeliberation` | ✅ ano (`type=followup_review`) | ✅ **ANO** |
| **Otázka pro Haničku** (`ask_hanka`) | `briefing.ask_hanka[i]` | `openAskWorkspace` | ❌ NE — vytváří `did_thread` (Karel chat) | ❌ NE — jiný flow |
| **Otázka pro Káťu** (`ask_kata`) | `briefing.ask_kata[i]` | `openAskWorkspace` | ❌ NE — vytváří `did_thread` (Karel chat) | ❌ NE — jiný flow |
| **Otázka pro kluky** (`ask_kluci`) | `briefing.ask_kluci[i]` | `openAskWorkspace` | ❌ NE — vytváří `did_thread` (DID chat) | ❌ NE — jiný flow |
| **Karlova narativní syntéza** (text odstavce) | `briefing.narrative_prose` | žádný — read-only text | ❌ N/A | ❌ N/A |

**Souhrn:**
- ✅ Fix se projeví na: **proposed_session** + všech 5 typů **decisions** (crisis, clinical, supervision, team_task, followup_review).
- ❌ Fix se NEprojeví na: ask_hanka/ask_kata/ask_kluci — ty jdou přes `did_threads` workspace, mají vlastní idempotenci přes `workspace_type+workspace_id` (případný bug tam je mimo scope tohoto passu).

## C. Změněné soubory

1. **`supabase/functions/karel-team-deliberation-create/index.ts`**
   — dvoukroková kaskáda lookupu (active → approved → insert), oba kroky bez date filtru.
   — race-recovery branch v 23505 handleru rozšířit o `approved` whitelist.

2. **Migration** (přes `supabase--migration` tool)
   — `DROP INDEX IF EXISTS uniq_did_team_delib_active_briefing_item;`
   — `CREATE UNIQUE INDEX uniq_did_team_delib_briefing_item ON did_team_deliberations (user_id, linked_briefing_item_id) WHERE linked_briefing_item_id IS NOT NULL AND status IN ('draft','active','awaiting_signoff','approved');`

3. **`src/components/did/DeliberationRoom.tsx`**
   — read-only banner + `isApproved` flag → disable interactives.

4. **Data repair** (přes `supabase--insert` tool, idempotentní DELETE bez hardcoded IDs, viz B4).

## D. Co NEMĚNÍM

- `useTeamDeliberations` whitelist filter (`active|awaiting_signoff`) — záměrně nezobrazuje approved v dashboard panelu (UX rozhodnutí, není v scope).
- Karlovu syntézu / signoff bridge / crisis_event update — to už funguje z předchozích passů.
- `DidDailyBriefingPanel` click handlery — server idempotence stačí, klient se nemění.
- `ask_*` flow přes `did_threads` — jiný bug pattern, mimo scope.

## E. Validace po implementaci (pořadí výstupu)

A. **Root cause recap** — krátké shrnutí 3 vrstev (server lookup, unique index, UI absence read-only modu).
B. **Opravené soubory** — výpis.
C. **Repair krok pro existující duplicity** — before audit (počet duplicit = N), repair SQL (idempotentní), after audit (musí být 0).
D. **Důkaz Arthur**:
   - Před fix: SELECT pro `linked_briefing_item_id='5dde49c1…'` vrátí 2 řádky.
   - Po repair: vrátí jen 1 řádek (approved `8ac5d27a…`).
   - Po server fix: další klik z briefingu na Arthur card vrátí `reused: true` + `id=8ac5d27a…`, klient otevře read-only banner.
E. **Mapa dalších dotčených položek z Karlova přehledu** (viz B5 — znovu shrnout v reportu).
F. **`tsc --noEmit`** — clean.
G. **Unified diff** — všech změněných souborů (server fn + DeliberationRoom) + migration SQL + repair SQL.
