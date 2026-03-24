

# Plan: Fix Session Plan Generation + UI Navigation/Theme Issues

## Part A: Fix `karel-did-auto-session-plan` errors

### Error 1: Duplicate key constraint
The table `did_daily_session_plans` has `UNIQUE(user_id, plan_date)` but the function needs to INSERT multiple plans per day (manual overrides, different parts). The auto-plan check (line 329-341) only skips `generated_by=auto`, but the DB constraint blocks ALL duplicates.

**Fix**: SQL migration to drop the unique constraint on `(user_id, plan_date)` — the function already supports multiple plans per day by design.

### Error 2: Cannot export Google Sheets file as text/plain
`readFileContent` tries to export `01_Index_Vsech_Casti` (which is a Google Sheet) using `mimeType=text/plain`. Google Sheets need `text/csv` export.

**Fix**: In `readFileContent`, detect `application/vnd.google-apps.spreadsheet` and export as `text/csv` instead of `text/plain`.

### Files to edit:
- `supabase/functions/karel-did-auto-session-plan/index.ts` — fix `readFileContent` for Sheets
- SQL migration — drop the unique constraint

---

## Part B: ThemeQuickButton dedup fix

Remove the `screenButtonOwners` dedup mechanism entirely. Multiple small palette buttons can coexist — simpler and eliminates the disappearing-button bug.

### File: `src/components/ThemeQuickButton.tsx`
- Remove `screenButtonOwners` Map, `getScreenScope`, `shouldRender` logic
- Keep the component simple: always render

---

## Part C: Swipe-back global fallback fix

### File: `src/components/MobileSwipeBack.tsx`
- Remove `document.querySelector("[data-swipe-back='true']")` fallback (line 84-85)
- Only use `startTarget.closest(...)` — if no local back button found, do nothing

---

## Part D: DID mode navigation stability

### File: `src/pages/Chat.tsx`
1. **Mode-change useEffect (line 348)**: Add guard `if (prevModeRef.current === mode) return;` at the top to prevent re-runs from other dependency changes
2. **`handleDidBackHierarchical`**: Remove `restoreGlobalTheme()` calls from `case "chat"` and `case "thread-list"` — the theme cleanup in `DidContentRouter.tsx` useEffect (line 178) already handles this

---

## Summary of changes (5 files):
1. SQL migration — drop `did_daily_session_plans` unique constraint on `(user_id, plan_date)`
2. `supabase/functions/karel-did-auto-session-plan/index.ts` — Sheets export fix
3. `src/components/ThemeQuickButton.tsx` — remove dedup guard
4. `src/components/MobileSwipeBack.tsx` — remove global fallback
5. `src/pages/Chat.tsx` — mode-change guard + remove `restoreGlobalTheme` from back handler

