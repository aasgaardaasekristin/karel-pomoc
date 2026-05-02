/**
 * P2: canonicalUserScopeGuard (TS edge helper)
 *
 * Fail-closed canonical DID user scope check for edge functions.
 *
 * Reads from public.did_canonical_scope via the SECURITY DEFINER SQL function
 * `get_canonical_did_user_id()`. NEVER hardcoded UUID. NEVER email lookup at
 * runtime. The DB row IS the truth.
 *
 * Usage inside an edge function:
 *
 *   import { assertCanonicalDidScopeOrThrow } from "../_shared/canonicalUserScopeGuard.ts";
 *   const canonicalUserId = await assertCanonicalDidScopeOrThrow(adminClient, auth.user.id);
 *
 * Throws CanonicalUserScopeError when:
 *   - no active+ready row exists (CANONICAL_USER_SCOPE_UNRESOLVED)
 *   - more than one active+ready row exists (CANONICAL_USER_SCOPE_AMBIGUOUS)
 *   - the calling user is not the canonical user (CANONICAL_USER_SCOPE_MISMATCH)
 */

export type CanonicalUserScopeErrorCode =
  | "CANONICAL_USER_SCOPE_UNRESOLVED"
  | "CANONICAL_USER_SCOPE_AMBIGUOUS"
  | "CANONICAL_USER_SCOPE_MISMATCH";

export class CanonicalUserScopeError extends Error {
  public readonly code: CanonicalUserScopeErrorCode;
  public readonly callingUserId: string | null;
  constructor(code: CanonicalUserScopeErrorCode, message: string, callingUserId: string | null) {
    super(message);
    this.code = code;
    this.callingUserId = callingUserId;
  }
}

// Minimal Supabase admin client surface we rely on (avoids importing types here).
export type AdminClientLike = {
  rpc: (
    fn: string,
    args?: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message: string; code?: string } | null }>;
};

/**
 * Returns the canonical DID user id when the scope row is healthy AND the
 * calling user matches it. Throws CanonicalUserScopeError otherwise.
 */
export async function assertCanonicalDidScopeOrThrow(
  admin: AdminClientLike,
  callingUserId: string | null | undefined,
): Promise<string> {
  const { data, error } = await admin.rpc("get_canonical_did_user_id");
  if (error) {
    const msg = String(error.message || "");
    if (/CANONICAL_USER_SCOPE_UNRESOLVED/.test(msg)) {
      throw new CanonicalUserScopeError(
        "CANONICAL_USER_SCOPE_UNRESOLVED",
        "Canonical DID user scope is not configured (no active+ready row). Admin must run set_canonical_did_user.",
        callingUserId ?? null,
      );
    }
    if (/CANONICAL_USER_SCOPE_AMBIGUOUS/.test(msg)) {
      throw new CanonicalUserScopeError(
        "CANONICAL_USER_SCOPE_AMBIGUOUS",
        "Canonical DID user scope is ambiguous (more than one active+ready row).",
        callingUserId ?? null,
      );
    }
    // Any other RPC error is treated as fail-closed too.
    throw new CanonicalUserScopeError(
      "CANONICAL_USER_SCOPE_UNRESOLVED",
      `Canonical scope guard RPC failed: ${msg}`,
      callingUserId ?? null,
    );
  }

  const canonicalUserId = typeof data === "string" ? data : null;
  if (!canonicalUserId) {
    throw new CanonicalUserScopeError(
      "CANONICAL_USER_SCOPE_UNRESOLVED",
      "Canonical scope guard returned no user id.",
      callingUserId ?? null,
    );
  }

  if (!callingUserId || callingUserId !== canonicalUserId) {
    throw new CanonicalUserScopeError(
      "CANONICAL_USER_SCOPE_MISMATCH",
      `Calling user ${callingUserId ?? "(none)"} is not the canonical DID user.`,
      callingUserId ?? null,
    );
  }

  return canonicalUserId;
}

/**
 * Convert a CanonicalUserScopeError into an HTTP-safe payload.
 */
export function canonicalScopeErrorResponse(err: CanonicalUserScopeError) {
  const status = err.code === "CANONICAL_USER_SCOPE_MISMATCH" ? 403 : 500;
  return {
    status,
    body: {
      ok: false,
      error_code: err.code,
      message: err.message,
    },
  };
}
