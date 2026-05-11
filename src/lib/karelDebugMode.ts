/**
 * P33.6 — Karel debug mode gate.
 *
 * Returns true only when the operator explicitly requests admin/debug
 * surfaces (Technické podklady, AI polish náhled). In normal therapist
 * workflows it MUST return false, so internal panels never leak into
 * the visible Karel briefing.
 *
 * Activation:
 *   - URL query: `?karelDebug=1`
 *   - localStorage: `karel_debug` === "1"
 */

export function isKarelDebugMode(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get("karelDebug") === "1") return true;
    if (window.localStorage?.getItem?.("karel_debug") === "1") return true;
  } catch {
    /* SSR / restricted env */
  }
  return false;
}
