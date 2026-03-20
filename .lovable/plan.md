

# Plan: Heartbeat-based Locking + 3 Separate Update Buttons

## Overview
Fix the unreliable locking mechanism in `karel-memory-mirror` and split the single "Aktualizovat kartotéku" button into 3 independent buttons, each triggering a separate job. Implementation follows the user's 6-step order.

---

## Step 1: Heartbeat-based Locking Fix

### Backend: `supabase/functions/karel-memory-mirror/index.ts`
- **Concurrency lock**: Change from `created_at`-based (5 min) to checking `updated_at` on `karel_memory_logs`. A job is "alive" only if `updated_at < 3 min ago`.
- **Heartbeat in continue calls**: Every `continue` call updates `updated_at` via the existing `persistMirrorJob` function (it already calls `.update()` on the log row — we just need to add `updated_at: new Date().toISOString()` to that update).
- **Force mode**: Accept `force: true` parameter. When set, delete all existing `mirror_job` rows for the user before creating a new one.
- **Clear done/error state**: `finalizeMirrorJob` sets `log_type` to `mirror_done` (not `redistribute`). On error, set to `mirror_failed`.

### DB Migration: Add `updated_at` to `karel_memory_logs`
- The table currently has no `updated_at` column. Add it with default `now()`.
- Update the CHECK constraint on `log_type` to include `mirror_done` and `mirror_failed`.

### Frontend: `src/pages/Chat.tsx` `handleManualUpdate`
- Before starting mirror: delete all `mirror_job` rows with `updated_at` older than 3 min (force cleanup).
- Pass `force: true` to mirror init call.
- Add 10-minute global timeout (AbortController) for the entire polling loop.
- If mirror fails/times out, continue to registry sync phase.

### RLS: Add UPDATE and DELETE policies for `karel_memory_logs`
- Currently missing UPDATE and DELETE policies. Need both for heartbeat writes and force cleanup from frontend.

---

## Step 2: Add `job_type` Column to `karel_memory_logs`

### DB Migration
- Add column `job_type text default 'mirror'` to `karel_memory_logs`.
- Values: `mirror`, `centrum`, `pamet`.

---

## Step 3: Create `karel-did-centrum-sync` Edge Function

### New file: `supabase/functions/karel-did-centrum-sync/index.ts`
- Same polling architecture as `karel-memory-mirror` (init → continue calls).
- **Harvest**: Read unprocessed threads from ALL 3 sub-modes (`cast`, `hanka`, `kata`).
- **AI Pass**: Use Gemini to generate updates for 00_CENTRUM documents (Dashboard, Terapeuticky_Plan, etc.).
- **Write**: Update CENTRUM documents on Drive.
- **Heartbeat**: Same mechanism — update `updated_at` on each continue.
- **Concurrency**: Same pattern — check `updated_at < 3 min`, support `force: true`.
- **job_type**: `centrum` in `karel_memory_logs`.
- Add to `supabase/config.toml` with `verify_jwt = false`.

---

## Step 4: Create `karel-pamet-sync` Edge Function

### New file: `supabase/functions/karel-pamet-sync/index.ts`
- Same architecture.
- **Harvest**: Read unprocessed threads from ALL 3 sub-modes.
- **AI Pass**: Generate updates for PAMET_KAREL documents (HANKA/ and KATA/ subfolders, 5 docs each).
- **Write**: Update PAMET_KAREL documents on Drive.
- **Heartbeat + concurrency**: Same mechanism.
- **job_type**: `pamet` in `karel_memory_logs`.
- Add to `supabase/config.toml`.

---

## Step 5: UI — 3 Buttons in DidSprava

### `src/components/did/DidSprava.tsx`
- Replace single "Aktualizovat kartotéku" ToolButton with 3 buttons:
  1. **"Aktualizovat kartotéku"** (blue) — calls `handleManualUpdate` (mirror)
  2. **"Aktualizovat centrum"** (green) — calls new `handleCentrumSync`
  3. **"Aktualizovat správu"** (purple) — calls new `handlePametSync`
- Each has independent loading state and toast feedback.
- Only visible when logged-in user is Hanka (admin check).

### `src/components/did/DidDashboard.tsx`
- Add new state variables and handler functions for centrum and pamet sync.
- Pass handlers down to DidSprava.

### `src/pages/Chat.tsx`
- Add `handleCentrumSync` and `handlePametSync` functions with same pattern as `handleManualUpdate` but calling different edge functions.
- Both use heartbeat-aware polling, 10-min timeout, force mode.

---

## Step 6: Update `karel-did-daily-cycle` for Sequential Execution

### `supabase/functions/karel-did-daily-cycle/index.ts`
- In the daily cycle flow, after existing processing, call all 3 jobs sequentially:
  1. `karel-memory-mirror` (with polling until done/error)
  2. `karel-did-centrum-sync` (with polling until done/error)
  3. `karel-pamet-sync` (with polling until done/error)
- Each waits for previous to finish. If one fails, log error and continue to next.
- Use `force: true` for all three.

---

## Files to Modify/Create

| File | Action |
|------|--------|
| `supabase/functions/karel-memory-mirror/index.ts` | Heartbeat, force mode, done/failed states |
| `src/pages/Chat.tsx` | Force cleanup, 10min timeout, new sync handlers |
| `src/components/did/DidSprava.tsx` | 3 colored buttons |
| `src/components/did/DidDashboard.tsx` | New state + handlers |
| `supabase/functions/karel-did-centrum-sync/index.ts` | **NEW** |
| `supabase/functions/karel-pamet-sync/index.ts` | **NEW** |
| `supabase/functions/karel-did-daily-cycle/index.ts` | Sequential 3-job execution |
| `supabase/config.toml` | Add new functions |
| DB migration | `updated_at` + `job_type` columns, UPDATE/DELETE RLS policies |

---

## Implementation Order
As requested: Step 1 first, then wait for confirmation before each subsequent step.

