/**
 * FIX 8.4 — Mapping segment label → Drive target ve složce
 * PAMET_KAREL/DID/HANKA/.
 *
 * Konzervativní switch (per rozhodnutí Karla v 8.4):
 *   intimate_self     → SITUACNI_ANALYZA.txt
 *   team_about_did    → VLAKNA_POSLEDNI.txt
 *   team_about_kata   → KDO_JE_KDO.txt
 *   team_logistics    → VLAKNA_POSLEDNI.txt
 *   meta_to_karel     → KARLOVY_POZNATKY.txt
 *   ambiguous         → null  (žádný shadow zápis)
 *   unknown future    → null  (forward-compat, ne crash)
 *
 * KAREL.txt a PROFIL_OSOBNOSTI.txt / STRATEGIE_KOMUNIKACE.txt zde záměrně
 * nejsou cílem — KAREL.txt slouží jen jako bootstrap rezervace názvu,
 * v 8.6 dostane vlastní label (`karel_self_note`).
 */

import type { HanaTurnSegment } from "./hanaTurnSegmenter.ts";

export const HANA_SEGMENT_TARGET_BASE = "PAMET_KAREL/DID/HANKA/";

export function mapSegmentToHanaFile(segment: { label: HanaTurnSegment["label"] | string }): string | null {
  switch (segment.label) {
    case "intimate_self":   return HANA_SEGMENT_TARGET_BASE + "SITUACNI_ANALYZA.txt";
    case "team_about_did":  return HANA_SEGMENT_TARGET_BASE + "VLAKNA_POSLEDNI.txt";
    case "team_about_kata": return HANA_SEGMENT_TARGET_BASE + "KDO_JE_KDO.txt";
    case "team_logistics":  return HANA_SEGMENT_TARGET_BASE + "VLAKNA_POSLEDNI.txt";
    case "meta_to_karel":   return HANA_SEGMENT_TARGET_BASE + "KARLOVY_POZNATKY.txt";
    case "ambiguous":       return null;
    default:                return null;
  }
}
