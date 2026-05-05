// P28_CDI_2b — Safe synthetic smoke helper. Inserts dynamic_pipeline_events
// rows for surfaces where running a real clinical action would be unsafe
// (e.g. DID part chat). Always raw_allowed=false, marked p28_cdi_2b_smoke.
import { recordServerSubmission, type ServerSurfaceType, type ServerEventType } from "./dynamicPipelineServer.ts";

export async function emitSafeSmoke(opts: {
  sb: any;
  userId: string;
  surfaceType: ServerSurfaceType;
  surfaceId: string;
  eventType: ServerEventType;
  marker?: string;
}) {
  return await recordServerSubmission({
    sb: opts.sb,
    userId: opts.userId,
    surfaceType: opts.surfaceType,
    surfaceId: opts.surfaceId,
    eventType: opts.eventType,
    safeSummary: `[P28_CDI_2B_SMOKE] ${opts.marker ?? "synthetic safe marker"}`,
    rawAllowed: false,
    metadata: {
      p28_cdi_2b_smoke: true,
      no_child_raw_text: true,
      marker: opts.marker ?? "synthetic",
    },
  });
}
