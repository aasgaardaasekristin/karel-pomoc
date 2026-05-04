/**
 * P18: canonicalUserResolver — single source of truth for "which DID user".
 *
 * Replaces every legacy fallback like:
 *   const { data } = await sb.from("did_threads").select("user_id").limit(1)
 *   userId = data?.user_id ?? null;
 *
 * That pattern was the root cause of pre-P13 wrong-user drift: if the DB
 * happened to surface a stale row from user `3f6cfad2…`, the cron pipeline
 * would silently switch scope.
 *
 * Contract:
 *   - Reads canonical user ID via `get_canonical_did_user_id()` SECURITY
 *     DEFINER RPC (same as canonicalUserScopeGuard).
 *   - If the explicit `requestedUserId` is provided AND matches canonical, returns it.
 *   - If `requestedUserId` is null/undefined, returns canonical (cron paths).
 *   - If `requestedUserId` is provided AND DOES NOT MATCH canonical, FAIL CLOSED.
 *
 * NEVER falls back to "latest thread", "first part", "any user".
 */

export type AdminClientLike = {
  rpc: (
    fn: string,
    args?: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message: string; code?: string } | null }>;
};

export class CanonicalScopeResolveError extends Error {
  public readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Returns the canonical DID user ID. Use this in EVERY edge function that
 * needs to know "which user is the DID system for".
 *
 * @param admin Supabase admin client (service role).
 * @param requestedUserId Optional user id from JWT/body. If provided, must match canonical.
 */
export async function resolveCanonicalDidUserId(
  admin: AdminClientLike,
  requestedUserId?: string | null,
): Promise<string> {
  const { data, error } = await admin.rpc("get_canonical_did_user_id");
  if (error) {
    const msg = String(error.message || "");
    throw new CanonicalScopeResolveError(
      "CANONICAL_USER_SCOPE_UNRESOLVED",
      `Canonical DID scope RPC failed: ${msg}`,
    );
  }
  const canonical = typeof data === "string" ? data : null;
  if (!canonical) {
    throw new CanonicalScopeResolveError(
      "CANONICAL_USER_SCOPE_UNRESOLVED",
      "Canonical DID scope returned no user id (no active+ready row).",
    );
  }
  if (requestedUserId && requestedUserId !== canonical) {
    throw new CanonicalScopeResolveError(
      "CANONICAL_USER_SCOPE_MISMATCH",
      `Requested user ${requestedUserId} is not the canonical DID user.`,
    );
  }
  return canonical;
}

/**
 * Soft variant for backwards compatibility during migration: returns canonical
 * if available, else null. NEVER returns a wrong-user fallback.
 *
 * Prefer `resolveCanonicalDidUserId` (throwing) for new code.
 */
export async function resolveCanonicalDidUserIdOrNull(
  admin: AdminClientLike,
): Promise<string | null> {
  try {
    return await resolveCanonicalDidUserId(admin, null);
  } catch {
    return null;
  }
}
