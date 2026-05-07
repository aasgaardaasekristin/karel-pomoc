# P33.1 — Release Freeze Runbook

**Status:** ACCEPTED — production regression lock active.
**No runtime logic changed.** This is a documentation + monitoring artifact only.

---

## 1. Accepted Production State

The following blocks are accepted and locked:

| Block | Scope | Status |
|---|---|---|
| **P29A** | Drive governance hard gate (`safeEnqueueDriveWrite`, `gateDriveWriteInsert`) | ✅ |
| **P29B** | Daily-cycle phase jobs orchestrator + 14 required job kinds | ✅ |
| **P29B.3-H1..H8** | Detached phase helpers, durable launcher, single-controller phase8a5 | ✅ |
| **P29C.1** | Daily Briefing Truth Gate | ✅ |
| **P30.1 / P30.2** | External Reality source-truth + daily orchestrator | ✅ |
| **P31.1 / P31.1b / P31.1c** | Karel voice renderer + briefing panel display rule | ✅ |
| **P31.2A / P31.2B / P31.2B.1** | AI polish candidate-only + canary, no publish | ✅ |
| **P31.2C** | AI polish read-only preview panel (no UI write path) | ✅ |
| **P32.1** | Hana personal identity end-to-end write-side guardrails | ✅ |
| **P32.2** | Hana personal response guard + golden regression | ✅ |
| **P32.3** | Hana personal end-to-end golden replay | ✅ |
| **P33** | Global production readiness regression lock | ✅ |

**Test baseline:** vitest 621/621 passing.

---

## 2. Primary Files (do not modify without re-running full regression)

### Drive governance
- `supabase/functions/_shared/documentGovernance.ts` — `safeEnqueueDriveWrite`, `gateDriveWriteInsert`, `blockHanaAliasPartWrite`
- `supabase/functions/karel-task-drive-enqueue/index.ts` — server proxy (UI cannot bypass)

### Daily cycle
- `supabase/functions/_shared/dailyCyclePhaseJobs.ts` — `P29B3_REQUIRED_PHASE_JOB_KINDS` (single source of truth)
- `supabase/functions/_shared/dailyBriefingTruthGate.ts` — `evaluateDailyBriefingTruthGate`
- `supabase/functions/karel-daily-cycle-main/` — orchestrator
- `supabase/functions/karel-daily-cycle-phase-worker/` — detached phase worker

### Briefing
- `src/components/did/DidDailyBriefingPanel.tsx` — production renderer (deterministic only)
- `src/components/did/AiPolishCanaryPreviewPanel.tsx` — read-only preview (no write actions)
- `src/lib/karelRender/` — deterministic human voice renderer

### External reality
- `supabase/functions/karel-external-reality-*` — source-backed events only

### Hana personal identity
- `supabase/functions/_shared/hanaPersonalIdentityResolver.ts` — `resolveHanaPersonalIdentity`
- `supabase/functions/_shared/hanaPersonalResponseGuard.ts` — `validateHanaPersonalResponseIdentity`
- `supabase/functions/_shared/observations.ts`, `didEventIngestion.ts` — write-side guards
- `supabase/functions/karel-hana-chat/index.ts` — integrates resolver + response guard

---

## 3. Critical Invariants

1. **No client-side or server bypass of `safeEnqueueDriveWrite`.** Every Drive write goes through governance.
2. **`KARTA_HANA / KARTA_HANKA / KARTA_HANIČKA / KARTA_KAREL` must never exist** as active part cards or queue entries.
3. **Daily briefing displayed in production UI is deterministic** (`karelRender`). AI polish text is never written to `polished_text` consumed by `DidDailyBriefingPanel`.
4. **`P29B3_REQUIRED_PHASE_JOB_KINDS` (14 kinds)** must all reach a terminal state per cycle, with zero duplicates.
5. **External reality events** must carry a real `source_url`; auto-verified is forbidden.
6. **`speaker_identity = hana_therapist`** for any Hana-thread audit row; ambiguous → clarify, no write.

---

## 4. Known Non-Blocking Caveats

- **`cron.job` SELECT requires elevated grant.** Direct SQL proof of cron schedules is gated by `permission denied for schema cron`. Runtime activity is provable instead via worker boot cadence + edge logs. A future maintenance step may grant a read-only role; this is not a P33 reopener.
- **`deno check` not available in sandbox.** Type/contract proof is delivered via full vitest + no-new-errors. If a CI host with Deno is added later, wire it as a monitoring check, not a regression gate.
- **`karel-did-session-evaluate`** emits known non-fatal Deno node-compat warnings. Do not page on these.

---

## 5. Runtime Proof Queries

See [`P33_1_MONITORING_CHECKLIST.md`](./P33_1_MONITORING_CHECKLIST.md) for the SQL pack.

---

## 6. Cadence

| When | Action |
|---|---|
| **Daily (morning)** | Run monitoring checklist after the daily cycle completes. All checks must be green. |
| **After any deploy** | Run the full P33 regression query pack (checklist sections 1–7). |
| **Weekly** | Run full vitest (`bunx vitest run`). Expect 621/621 (or current baseline). |
| **Before enabling AI polish in main UI** | Re-run `p31_2bCanaryAiPolishNoPublish.test.ts` and `p31_2cAiPolishPreviewReadOnly.test.tsx`. Do NOT skip. |
| **Before any Hana routing change** | Re-run `p32_1`, `p32_2`, `p32_3` test files end to end. |

---

## 7. Freeze Policy

- ❌ No new features.
- ❌ No P34.
- ❌ No AI polish enablement in the production briefing UI.
- ❌ No Hana routing changes.
- ❌ No daily-cycle architecture changes.
- ❌ No Drive governance changes.
- ❌ No external reality changes.
- ❌ No UI feature changes.

Freeze ends only after **at least one natural morning cycle + briefing + external orchestrator** runs in normal operation and the monitoring checklist remains fully green.

---

## 8. Final Statement

**No runtime logic was changed by P33.1.** This document and the monitoring checklist are the only artifacts produced.
