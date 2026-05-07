/**
 * P33.5B — internal edge auth helper.
 *
 * Builds a single, reliable header set for internal edge-to-edge HTTP
 * calls (phase worker → downstream functions). Includes both:
 *   - Authorization: Bearer <service role key>  (preferred)
 *   - X-Karel-Cron-Secret: <vault secret>       (compatibility / cron path)
 *
 * Never logs the actual secret values. Only booleans for diagnostics.
 */

export async function getKarelCronSecret(admin: any): Promise<string | null> {
  try {
    const { data, error } = await admin.rpc("get_karel_cron_secret");
    if (error || typeof data !== "string" || data.length === 0) return null;
    return data;
  } catch {
    return null;
  }
}

export type InternalEdgeHeaderFlags = {
  has_service_bearer: boolean;
  has_cron_secret: boolean;
};

export async function buildInternalEdgeHeaders(
  admin: any,
  extra?: Record<string, string>,
): Promise<{ headers: Record<string, string>; flags: InternalEdgeHeaderFlags }> {
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const cronSecret = await getKarelCronSecret(admin);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(extra ?? {}),
  };

  if (serviceKey) {
    headers.Authorization = `Bearer ${serviceKey}`;
    // apikey header helps the platform gateway treat the request as
    // service-role even when verify_jwt is enabled for the target.
    headers.apikey = serviceKey;
  }
  if (cronSecret) {
    headers["X-Karel-Cron-Secret"] = cronSecret;
    headers["x-karel-cron-secret"] = cronSecret;
  }

  return {
    headers,
    flags: {
      has_service_bearer: Boolean(serviceKey),
      has_cron_secret: Boolean(cronSecret),
    },
  };
}
