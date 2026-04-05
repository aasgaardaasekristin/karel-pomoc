

## F17-HOTFIX: Context Prime Boot Fix

### Root Cause
`const cacheKey` is declared twice in the same `try {}` scope (line 704 and line 1412), causing a runtime crash → 500 → "bez plné cache" toast.

### Changes (single file: `supabase/functions/karel-did-context-prime/index.ts`)

1. **Line 697** — Add structured start log after `try {`:
   ```
   console.log('[CONTEXT PRIME] start');
   ```

2. **Line 704** — Add cache hit/miss log (already exists at line 718 for hit; add miss log after the `if` block ~line 725).

3. **Line 1412** — Rename `const cacheKey` → `const saveCacheKey` and update its 3 usages on lines 1415, 1419, 1423.

4. **Line 1428** — Add build-ok log before return:
   ```
   console.log('[CONTEXT PRIME] build ok');
   ```

5. **Lines 1430-1434** — Enhance catch block:
   - Add `console.error('[CONTEXT PRIME] fatal error', error)`
   - Insert into `system_health_log` with `severity: 'critical'`, `source: 'context-prime'`

No other lines touched.

