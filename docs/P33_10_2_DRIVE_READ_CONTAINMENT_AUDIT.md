# P33.10.2 — Drive Read Containment + DB-first UI Runtime

## Part A — Forensic caller audit (`karel-did-drive-read`)

| # | File | Line | Trigger | Payload | Recursive/Global | Page-load? | Verdict |
|---|------|------|---------|---------|------------------|-----------|---------|
| 1 | `src/pages/Chat.tsx` | 678 | `mode === "childcare"` change (DID page open) | `documents:[6 centrum docs], subFolder:"00_CENTRUM", allowGlobalSearch:false` | recursive within `00_CENTRUM` only, no global | **YES — DID mode open** | UNSAFE: runs on every DID open. Must be DB-first; Drive enqueued in background. |
| 2 | `src/pages/Chat.tsx` | 937 | thread open by part name (no `subFolder`) | `documents:[Karta_<part>]` | recursive + **globalSearch on (allowGlobalSearch undefined && no subFolder ⇒ true)** | YES (thread open) | UNSAFE: globalSearch fallback walks whole drive. Bound + no global by default. |
| 3 | `src/pages/Chat.tsx` | 988 | new cast thread created | same as #2 | global ON | YES (thread create) | UNSAFE same as #2. |
| 4 | `src/pages/Chat.tsx` | 1111 | continue thread | same as #2 | global ON | YES (thread switch) | UNSAFE same as #2. |
| 5 | `src/pages/Chat.tsx` | 1530 (`loadDriveContext`) | helper used by enrichment | centrum 5 docs, `allowGlobalSearch:false` | recursive only in 00_CENTRUM | manual call | OK after Part D bounding. |
| 6 | `src/pages/Chat.tsx` | 1623 | message-time enrichment when part mentioned | `documents:[Karta_<part>...]` (no subFolder) | global ON | per-message | UNSAFE — global fallback per-message. Bound. |
| 7 | `src/components/did/DidContentRouter.tsx` | 675 | "Načíst kontext" explicit button | centrum 4 docs, `allowGlobalSearch:false` | recursive in centrum | explicit click | OK. |
| 8 | `src/components/did/DidLiveSessionPanel.tsx` | 711 | explicit `drive_read` action requested by Karel | `partName:<active>, tailLines:180` | recursive partName mode | explicit action | OK after Part D bounding. THROWS on failure → must fail-soft. |
| 9 | `src/components/did/KarelDailyPlan.tsx` | 483 | daily plan render | `documents:["05A_OPERATIVNI_PLAN"], subFolder:"00_CENTRUM"` | recursive in centrum | render | OK (single doc, scoped). Already `.catch`. |
| 10 | `src/services/planUpdater.ts` | 41 | background plan updater (server-flow) | `{ documentName }` | depends | background | OK. |
| 11 | `supabase/functions/karel-did-part-summary/index.ts` | 61 | server side, on-demand part summary | `documents:[Karta_<part>]` | global ON (no subFolder) | server | UNSAFE — global fallback. Bound. |
| 12 | `supabase/functions/karel-kartoteka-archiver/index.ts` | 214 | archiver | varies | varies | background | OK. |

### Findings
- `drive_read_callers_audited = true`
- `blank_screen_caller_identified = true` — primary suspects: rows 1, 2/3/4 (thread open with global fallback), and row 6 (per-message global fallback). Any of these can hit 150 s `IDLE_TIMEOUT` because `findDocumentGlobal` does a single broad `name contains` over the whole Drive and `findDocumentRecursive` walks entire kartotéka subtrees with serial `await`.
- `unsafe_ui_drive_read_call_identified = true` — rows 1, 2, 3, 4, 6.

## Part B — Edge log / payload audit
- Last 24 h logs (function `karel-did-drive-read`) show the function being invoked from the UI and stalling inside recursive Drive walks; the platform terminates with `IDLE_TIMEOUT` (150 s).
- Request payloads observed: `{ partName, tailLines: 180 }` and `{ documents: [...], subFolder?, allowGlobalSearch? }`.
- After Part D, all entries log only: `action`, `target_label` (sanitized name, no content), `recursive`, `globalSearch`, `maxDepth`, `caller`, `requestId`, `elapsedMs`. No raw Drive content, no secrets.
- `drive_read_timeout_request_identified = true`
- `drive_read_payload_shape_known = true`
- `drive_read_no_secret_logging = true`

## Part C / F — DB-first rule for Pracovna
- Removed Drive preload on DID-mode open (`Chat.tsx` line 678) — replaced with DB-only registry/snapshot read; Drive context is **enqueued lazily** and never blocks UI.
- Per-thread `Karta_<part>` reads (rows 2, 3, 4, 6) are wrapped in `safeDriveRead` with a hard 12 s client-side budget and `recursive:false, allowGlobalSearch:false` defaults.
- `karel-did-drive-read` itself rejects recursive/global from non-explicit callers.

## Part D — Hard containment inside `karel-did-drive-read`
Implemented limits:
- `OVERALL_BUDGET_MS = 45_000`
- `PER_FETCH_TIMEOUT_MS = 8_000` (AbortController)
- `MAX_DEPTH = 2` (recursive folder descent)
- `MAX_FOLDERS = 80`, `MAX_FILES = 300`
- `MAX_GLOBAL_SEARCH_RESULTS = 30`
- `recursive=false`, `globalSearch=false` defaults; only opt-in via explicit body flag.
- On budget exhaustion the function returns HTTP 200 with `{ ok:false, status:"controlled_timeout", reason:"drive_read_budget_exhausted", partial:true, ... }` instead of letting the runtime time out at 150 s.

## Part E — Client fail-soft
- All UI callers wrap drive-read in `safeDriveRead()` (see `src/lib/safeDriveRead.ts`) which:
  - aborts after 12 s,
  - returns `{ ok:false, controlledTimeout:true }` instead of throwing,
  - emits a single non-blocking toast `"Drive detail se teď nepodařilo načíst; používám dostupná data z databáze."` (rate-limited).
- `DidLiveSessionPanel` `drive_read` action degrades gracefully (replies "Drive teď nedostupný, pokračuji z DB kontextu") instead of throwing.

## Part H / I — Runtime smokes & edge log proof
Performed via deploy + targeted curl after deploy:
1. **Pracovna open** — no `karel-did-drive-read` call observed; DB rows render; no blank screen.
2. **Forced broad search** — `{ documents:["xxxx"], allowGlobalSearch:true, recursive:true }` returns `controlled_timeout` within 45 s, no 504.
3. **Explicit card detail** — bounded card read returns within budget.

Edge log query for last 30 min: zero `IDLE_TIMEOUT`, zero 504 entries for `karel-did-drive-read`.
