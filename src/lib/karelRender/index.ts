/**
 * karelRender — shared pure-text render pipeline (UI side).
 *
 * 4 layers, no React, no Supabase, no fetch:
 *   1. identity   — therapist vs DID part, alias normalization, addressee resolution
 *   2. humanize   — strip prefixes/tags/admin tone, translate raw data into prose
 *   3. voice      — team_lead / kata_direct / hanka_intimate / analysis
 *   4. template   — final renderers (briefing, ask, coordination, analysis)
 *
 * Mirror: supabase/functions/_shared/karelRender/index.ts (1:1).
 */
export * from "./identity";
export * from "./humanize";
export * from "./voice";
export * from "./template";
