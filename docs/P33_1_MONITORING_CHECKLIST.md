# P33.1 — Monitoring Checklist (Read-Only SQL Pack)

**All queries are SELECT-only.** Run as a regular morning check or after any deploy. Each check has an expected result; deviation = investigate, do not auto-mutate.

> Replace `:user_id` with the Karel user UUID. Replace `:today_prague` with today's Prague-local date `YYYY-MM-DD`.

---

## 1. Drive Governance — invalid targets = 0

```sql
-- Expect: 0 rows
SELECT id, target_document, status, created_at
FROM drive_write_queue
WHERE status IN ('pending', 'processing')
  AND (
    target_document IS NULL
    OR target_document = ''
    OR target_document ILIKE 'KARTA_HANA%'
    OR target_document ILIKE 'KARTA_HANKA%'
    OR target_document ILIKE 'KARTA_HANI%KA%'
    OR target_document ILIKE 'KARTA_KAREL%'
  );
```

## 2. Drive Governance — unresolved KARTA retry loop = 0

```sql
-- Expect: 0 rows (KARTA_GERHARDT in manual_approval is OK and excluded)
SELECT target_document, COUNT(*) AS attempts
FROM drive_write_queue
WHERE status = 'failed'
  AND target_document ILIKE 'KARTA_%'
  AND target_document NOT ILIKE 'KARTA_GERHARDT%'
GROUP BY target_document
HAVING COUNT(*) >= 3;
```

## 3. Latest daily cycle — 14 distinct required jobs, all terminal

```sql
-- Expect: 1 row, distinct_required = 14, non_terminal = 0, failed = 0
WITH latest AS (
  SELECT id
  FROM did_update_cycles
  WHERE cycle_type = 'daily' AND user_id = :user_id
  ORDER BY started_at DESC
  LIMIT 1
)
SELECT
  l.id AS cycle_id,
  COUNT(DISTINCT j.job_kind) FILTER (WHERE j.job_kind IN (
    'phase4_centrum_tail','phase4_card_profiling','phase5_revize_05ab',
    'phase55_crisis_bridge','phase6_card_autoupdate','phase65_memory_cleanup',
    'phase7_operative_plan','phase75_escalation_emails','phase76_feedback_retry',
    'phase76b_auto_feedback_ai','phase8_therapist_intel',
    'phase8a5_session_eval_safety_net','phase8b_pantry_flush','phase9_drive_queue_flush'
  )) AS distinct_required,
  COUNT(*) FILTER (WHERE j.status IN ('queued','running'))                  AS non_terminal,
  COUNT(*) FILTER (WHERE j.status IN ('failed_retry','failed_permanent'))   AS failed
FROM latest l
LEFT JOIN did_daily_cycle_phase_jobs j ON j.cycle_id = l.id
GROUP BY l.id;
```

## 4. Latest briefing — truth_ok / human_ok / unsupported / robotic

```sql
-- Expect: truth_ok = true, human_ok = true, unsupported_claims = 0, robotic_phrases = 0
SELECT
  id, generated_at, truth_ok, human_ok,
  COALESCE(unsupported_claims_count, 0) AS unsupported_claims,
  COALESCE(robotic_phrases_count, 0)    AS robotic_phrases
FROM did_daily_briefings
WHERE user_id = :user_id
ORDER BY generated_at DESC
LIMIT 1;
```

## 5. Production AI polish attempted on main UI = false

```sql
-- Expect: 0 rows. AI polish is allowed only in canary preview, never on main briefing.
SELECT id, briefing_id, surface, attempted_at
FROM ai_polish_canary_audit
WHERE surface NOT IN ('canary_preview_read_only')
   OR published = true
ORDER BY attempted_at DESC
LIMIT 20;
```

## 6. External reality events — real source_url, no auto-verified

```sql
-- Expect: 0 rows
SELECT id, title, source_url, verification_status, created_at
FROM external_reality_events
WHERE created_at > now() - interval '48 hours'
  AND (
    source_url IS NULL
    OR source_url = ''
    OR source_url NOT ILIKE 'http%'
    OR verification_status = 'auto_verified'
  );
```

## 7. Hana / Karel identity safety — bad rows = 0

```sql
-- 7a) part registry contamination — expect 0
SELECT id, part_name, status
FROM did_part_registry
WHERE status = 'active'
  AND lower(part_name) IN ('hana','hanka','hanička','hanicka','karel');

-- 7b) card update queue contamination — expect 0
SELECT id, target_card, created_at
FROM card_update_queue
WHERE target_card ILIKE ANY (ARRAY[
  'KARTA_HANA%','KARTA_HANKA%','KARTA_HANI%KA%','KARTA_KAREL%'
]);

-- 7c) drive writes targeting Hana/Karel as a part — expect 0
SELECT id, target_document, status
FROM drive_write_queue
WHERE target_document ILIKE ANY (ARRAY[
  'KARTA_HANA%','KARTA_HANKA%','KARTA_HANI%KA%','KARTA_KAREL%'
]);

-- 7d) part observations attributed to Hana/Karel as speaker — expect 0
SELECT id, part_id, speaker_identity, created_at
FROM did_observations
WHERE speaker_identity IN ('hana','hanka','hanicka','hanička','karel')
  AND created_at > now() - interval '7 days';

-- 7e) Hana response-guard audit — expect every row blocked OR speaker_identity = hana_therapist
SELECT response_guard_status, speaker_identity, COUNT(*)
FROM hana_personal_response_guard_audit
WHERE created_at > now() - interval '24 hours'
GROUP BY 1, 2;
```

## 8. Recent edge 5xx = 0 or known-noise only

Run via Lovable Cloud edge logs UI (analytics):

```sql
SELECT id, function_edge_logs.timestamp, event_message, response.status_code,
       request.method, m.function_id
FROM function_edge_logs
  CROSS JOIN UNNEST(metadata) AS m
  CROSS JOIN UNNEST(m.response) AS response
  CROSS JOIN UNNEST(m.request) AS request
WHERE response.status_code >= 500
  AND function_edge_logs.timestamp > timestamp_sub(current_timestamp(), interval 24 hour)
ORDER BY function_edge_logs.timestamp DESC
LIMIT 100;
```

**Known noise (do not page):**
- `karel-did-session-evaluate` Deno node-compat warnings.

---

## 9. Caveats for SQL proofs (carry-over from P33)

- **Direct `cron.job` SELECT is not available** under default role (`permission denied for schema cron`). Prove cron health via worker boot cadence in edge logs instead.
- **`deno check`** is not run in sandbox; treat full vitest + no-new-errors as the contract proof.

---

## 10. Verdict template

After running checks 1–8, paste:

```
date: <YYYY-MM-DD Prague>
1.invalid_drive_targets:        0
2.unresolved_KARTA_retry:       0
3.daily_cycle_distinct_req:     14    non_terminal: 0    failed: 0
4.briefing truth_ok=true human_ok=true unsupported=0 robotic=0
5.production_ai_polish:         0
6.external_reality_bad:         0
7a-e.hana_karel_safety:         all 0 / hana_therapist
8.edge_5xx:                     0 (or known noise only)
verdict: GREEN — freeze holds
```

If any check fails: stop, escalate, do **not** auto-mutate. Re-open the relevant block (P29A / P29B / P29C / P30 / P31.2x / P32.x) with the failing rows attached.
