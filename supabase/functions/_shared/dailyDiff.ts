/**
 * dailyDiff.ts — Phase 2 Daily Memory Diff
 *
 * Pure helper that compares yesterday's and today's did_daily_context
 * snapshots and produces a structured diff for Karel:
 *   - new           = appeared today, was not present yesterday
 *   - worse         = present in both, but emotional state / risk got worse
 *   - unconfirmed   = older than 14 days and never re-confirmed
 *   - changed       = explicitly changed (status flip, new claim, etc.)
 *
 * NO DB queries. NO side effects.
 * Caller passes both context_json snapshots and persists the result back.
 */

export interface DailyDiff {
  generated_at: string;
  has_yesterday: boolean;
  new_items: DiffItem[];
  worse_items: DiffItem[];
  unconfirmed_items: DiffItem[];
  changed_items: DiffItem[];
  summary_line: string;
}

export interface DiffItem {
  scope: "part" | "task" | "claim" | "question" | "observation";
  subject: string;
  detail: string;
  yesterday_value?: string;
  today_value?: string;
}

interface PartSnap {
  name: string;
  display_name?: string;
  cluster?: string;
  emotional_state?: string;
  emotional_intensity?: number;
  health?: string;
}

interface ContextSnap {
  parts?: { active?: PartSnap[]; sleeping?: PartSnap[] };
  pending_tasks?: Array<{ task: string; assigned_to?: string; priority?: string; age_days?: number }>;
  pipeline?: {
    open_questions?: Array<{ subject?: string; question?: string }>;
    recent_observations?: Array<{ subject?: string; fact?: string; at?: string; evidence?: string }>;
    active_claims_summary?: Record<string, Array<{ section?: string; text?: string; confidence?: number; type?: string }>>;
  };
  generated_at?: string;
}

const NEGATIVE_EMOTIONS = new Set([
  "uzkostny", "úzkostný", "uzkostna", "úzkostná",
  "vystraseny", "vystrašený", "panicky", "panický",
  "rozcileny", "rozčilený", "vzteky", "vztek", "vzteklý",
  "smutny", "smutný", "deprese", "depresivni", "depresivní",
  "krizovy", "krizový", "rozhozeny", "rozhozený", "zhrouceny", "zhroucený",
  "dissociovany", "disociovaný", "ztraceny", "ztracený",
]);

const POSITIVE_EMOTIONS = new Set([
  "klidny", "klidný", "klidna", "klidná",
  "stabilni", "stabilní",
  "radostny", "radostný", "vesely", "veselý",
  "spolupracujici", "spolupracující",
  "otevreny", "otevřený", "duveryhodny", "důvěryhodný",
]);

function normalize(s?: string): string {
  if (!s) return "";
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function emotionRank(state?: string): number {
  // Higher = worse. Used to detect deterioration.
  const n = normalize(state);
  if (!n) return 0;
  if (NEGATIVE_EMOTIONS.has(n)) return 2;
  if (POSITIVE_EMOTIONS.has(n)) return -1;
  return 1; // neutral / unknown
}

function partsByName(snap?: ContextSnap): Map<string, PartSnap> {
  const m = new Map<string, PartSnap>();
  for (const p of snap?.parts?.active || []) {
    if (p?.name) m.set(p.name, p);
  }
  for (const p of snap?.parts?.sleeping || []) {
    if (p?.name) m.set(p.name, p);
  }
  return m;
}

/**
 * Compute the structured diff between today and yesterday.
 * Both inputs are the `context_json` blobs written by karel-daily-refresh.
 */
export function computeDailyDiff(
  today: ContextSnap | null | undefined,
  yesterday: ContextSnap | null | undefined,
): DailyDiff {
  const generated_at = new Date().toISOString();

  if (!today) {
    return {
      generated_at,
      has_yesterday: !!yesterday,
      new_items: [],
      worse_items: [],
      unconfirmed_items: [],
      changed_items: [],
      summary_line: "Žádný dnešní kontext k porovnání.",
    };
  }

  const new_items: DiffItem[] = [];
  const worse_items: DiffItem[] = [];
  const unconfirmed_items: DiffItem[] = [];
  const changed_items: DiffItem[] = [];

  const todayParts = partsByName(today);
  const yesterdayParts = partsByName(yesterday || undefined);

  // ── Parts: appeared today / mood worsened / status flipped ──
  for (const [name, p] of todayParts) {
    const y = yesterdayParts.get(name);
    if (!y) {
      new_items.push({
        scope: "part",
        subject: p.display_name || name,
        detail: `Nově v aktivním kontextu (klastr: ${p.cluster || "?"}, stav: ${p.emotional_state || "?"})`,
      });
      continue;
    }

    // Worsening
    const todayRank = emotionRank(p.emotional_state);
    const yesterdayRank = emotionRank(y.emotional_state);
    const intensityRose =
      typeof p.emotional_intensity === "number" &&
      typeof y.emotional_intensity === "number" &&
      p.emotional_intensity - y.emotional_intensity >= 2;

    if (todayRank > yesterdayRank || intensityRose) {
      worse_items.push({
        scope: "part",
        subject: p.display_name || name,
        detail: "Emoční stav se zhoršil oproti včerejšku.",
        yesterday_value: `${y.emotional_state || "?"} (${y.emotional_intensity ?? "?"}/10)`,
        today_value: `${p.emotional_state || "?"} (${p.emotional_intensity ?? "?"}/10)`,
      });
    }

    // Health flip
    if (p.health && y.health && normalize(p.health) !== normalize(y.health)) {
      changed_items.push({
        scope: "part",
        subject: p.display_name || name,
        detail: "Změna zdravotního/funkčního stavu.",
        yesterday_value: y.health,
        today_value: p.health,
      });
    }
  }

  // ── Tasks: new vs. yesterday ──
  const yesterdayTaskKeys = new Set(
    (yesterday?.pending_tasks || []).map((t) => normalize(t.task).slice(0, 80)),
  );
  for (const t of today?.pending_tasks || []) {
    const key = normalize(t.task).slice(0, 80);
    if (!yesterdayTaskKeys.has(key)) {
      new_items.push({
        scope: "task",
        subject: t.assigned_to || "tým",
        detail: `Nový úkol [${t.priority || "normal"}]: ${t.task.slice(0, 160)}`,
      });
    }
    if ((t.age_days ?? 0) > 7) {
      unconfirmed_items.push({
        scope: "task",
        subject: t.assigned_to || "tým",
        detail: `Úkol nepotvrzený ${t.age_days} dní: ${t.task.slice(0, 160)}`,
      });
    }
  }

  // ── Open questions: new vs. yesterday ──
  const yesterdayQuestions = new Set(
    (yesterday?.pipeline?.open_questions || []).map((q) =>
      normalize(q.question || "").slice(0, 80),
    ),
  );
  for (const q of today?.pipeline?.open_questions || []) {
    const key = normalize(q.question || "").slice(0, 80);
    if (!yesterdayQuestions.has(key)) {
      new_items.push({
        scope: "question",
        subject: q.subject || "obecné",
        detail: `Nová otevřená otázka: ${(q.question || "").slice(0, 160)}`,
      });
    }
  }

  // ── Observations: new (within last 24h vs. older) ──
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const o of today?.pipeline?.recent_observations || []) {
    const at = o.at ? new Date(o.at).getTime() : 0;
    if (at > cutoff) {
      new_items.push({
        scope: "observation",
        subject: o.subject || "obecné",
        detail: `[${o.evidence || "?"}] ${(o.fact || "").slice(0, 160)}`,
      });
    }
  }

  // ── Claims: hypotheses unconfirmed for too long ──
  const claimsToday = today?.pipeline?.active_claims_summary || {};
  for (const [partName, claims] of Object.entries(claimsToday)) {
    for (const c of claims) {
      if (
        c.type === "hypothesis" &&
        typeof c.confidence === "number" &&
        c.confidence < 0.5
      ) {
        unconfirmed_items.push({
          scope: "claim",
          subject: partName,
          detail: `Hypotéza s nízkou jistotou (${Math.round(c.confidence * 100)}%) [${c.section || "?"}]: ${(c.text || "").slice(0, 140)}`,
        });
      }
    }
  }

  const summary_line = `Diff: ${new_items.length} nových, ${worse_items.length} horších, ${changed_items.length} změněných, ${unconfirmed_items.length} nepotvrzených${yesterday ? "" : " (včerejšek chybí)"}.`;

  return {
    generated_at,
    has_yesterday: !!yesterday,
    new_items: new_items.slice(0, 30),
    worse_items: worse_items.slice(0, 20),
    unconfirmed_items: unconfirmed_items.slice(0, 20),
    changed_items: changed_items.slice(0, 20),
    summary_line,
  };
}
