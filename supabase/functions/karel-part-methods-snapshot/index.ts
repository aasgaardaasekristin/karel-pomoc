/**
 * karel-part-methods-snapshot
 * ---------------------------
 * Denní snímek "Použité metody na sezení (posledních 30 dnů)" pro každou
 * aktivní DID část. Zapisuje balík do Spižírny (did_pantry_packages),
 * který následný karel-pantry-flush-to-drive (03:15 UTC) propíše do
 * karty části na Drive (KARTA_<JMENO>) jako sekce M (REPLACE).
 *
 * Cíl: Karel (i terapeutky) na první pohled v kartě části vidí, které
 * metody/varianty už u této části byly nasazeny, s jakým výtěžkem
 * (clinical_yield 1–5) a snášenlivostí (tolerance 1–5). Tím Karel
 * dokáže klinicky rozhodnout, co JEŠTĚ nepoužít a kdy je nutná
 * povinná variace.
 *
 * Cron: 03:00 UTC denně (před flushem v 03:15).
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const WINDOW_DAYS = 30;

type HistoryRow = {
  part_id: string | null;
  part_name: string | null;
  method_key: string;
  variant_used: string | null;
  session_date: string | null;
  clinical_yield: number | null;
  tolerance: number | null;
  trauma_marker: boolean | null;
  notes_md: string | null;
  next_step_hint: string | null;
};

function fmtScore(n: number | null | undefined): string {
  if (n == null) return "—";
  return `${n}/5`;
}

function buildPartSection(partName: string, rows: HistoryRow[]): string {
  const dateStr = new Date().toISOString().slice(0, 10);
  if (rows.length === 0) {
    return [
      `[SEKCE:M:REPLACE]`,
      `# Použité metody na sezeních (posledních ${WINDOW_DAYS} dnů)`,
      `*Snímek ${dateStr} — Karel zatím u **${partName}** nezaznamenal žádnou metodu z knihovny.*`,
      ``,
      "Jakmile bude první metoda použita a vyhodnocena (`clinical_yield`, `tolerance`), objeví se zde.",
    ].join("\n");
  }

  // Seskup podle method_key — zobraz pořadí nejnověji použitých
  const byMethod = new Map<string, HistoryRow[]>();
  for (const r of rows) {
    const key = r.method_key;
    if (!byMethod.has(key)) byMethod.set(key, []);
    byMethod.get(key)!.push(r);
  }

  const lines: string[] = [];
  lines.push(`[SEKCE:M:REPLACE]`);
  lines.push(`# Použité metody na sezeních (posledních ${WINDOW_DAYS} dnů)`);
  lines.push(`*Snímek ${dateStr} — celkem ${rows.length} záznamů, ${byMethod.size} unikátních metod.*`);
  lines.push(``);
  lines.push(
    `> Karel toto pole používá k anti-repetition guardu (14 dní zákaz stejné kombinace) ` +
      `a k povinné variaci. Hodnoty `yield`/`tolerance` jsou klinické (1 = nízká, 5 = vysoká).`,
  );
  lines.push(``);

  // Seřaď metody podle nejnovějšího použití
  const orderedMethods = Array.from(byMethod.entries()).sort((a, b) => {
    const da = a[1][0].session_date ?? "";
    const db = b[1][0].session_date ?? "";
    return db.localeCompare(da);
  });

  for (const [methodKey, history] of orderedMethods) {
    const latest = history[0];
    lines.push(`## 🔹 \`${methodKey}\``);
    lines.push(
      `**Použito ${history.length}× za ${WINDOW_DAYS} dní · poslední: ${latest.session_date ?? "—"}**`,
    );
    if (latest.trauma_marker) {
      lines.push(``);
      lines.push(`> ⚠️ **TRAUMA MARKER** zaznamenán — při dalším nasazení s extrémní opatrností.`);
    }
    lines.push(``);
    lines.push(`| Datum | Varianta | Yield | Tolerance | Poznámka |`);
    lines.push(`|---|---|---|---|---|`);
    for (const h of history) {
      const note = (h.notes_md ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 90);
      lines.push(
        `| ${h.session_date ?? "—"} | ${h.variant_used ?? "*základní*"} | ${fmtScore(h.clinical_yield)} | ${fmtScore(h.tolerance)} | ${note || "—"} |`,
      );
    }
    if (latest.next_step_hint) {
      lines.push(``);
      lines.push(`**Karlův next-step hint:** ${latest.next_step_hint}`);
    }
    lines.push(``);
  }

  // Souhrn pro Karla — co JEŠTĚ nezkusit / co opakovat
  const promising = orderedMethods.filter(([, h]) => {
    const avgY = h.reduce((s, r) => s + (r.clinical_yield ?? 0), 0) / h.length;
    return avgY >= 4;
  }).map(([k]) => k);
  const struggling = orderedMethods.filter(([, h]) => {
    const avgT = h.reduce((s, r) => s + (r.tolerance ?? 0), 0) / h.length;
    return avgT > 0 && avgT <= 2;
  }).map(([k]) => k);

  lines.push(`---`);
  lines.push(`### Karlův souhrn pro klinické rozhodování`);
  if (promising.length) {
    lines.push(`- ✅ **Promising (yield ≥ 4):** ${promising.map((k) => `\`${k}\``).join(", ")}`);
  }
  if (struggling.length) {
    lines.push(`- ⚠️ **Struggling (tolerance ≤ 2):** ${struggling.map((k) => `\`${k}\``).join(", ")} — zvažte odložení nebo úpravu rámce.`);
  }
  if (!promising.length && !struggling.length) {
    lines.push(`- 📊 Zatím málo dat pro klinický soud — sbíráme dál.`);
  }

  return lines.join("\n");
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const startedAt = Date.now();
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  try {
    // 1) Najdi aktivní části (z registru)
    const { data: parts, error: partsErr } = await supabase
      .from("did_part_registry")
      .select("user_id, name")
      .eq("active", true);
    if (partsErr) throw partsErr;

    const partList = (parts ?? []).filter((p) => p.name && p.user_id);
    if (partList.length === 0) {
      return new Response(
        JSON.stringify({ ok: true, parts_processed: 0, message: "žádné aktivní části" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // 2) Načti historii za 30 dní (všechny part_name najednou)
    const sinceDate = new Date(Date.now() - WINDOW_DAYS * 86400_000)
      .toISOString()
      .slice(0, 10);
    const { data: histAll, error: histErr } = await supabase
      .from("did_part_method_history")
      .select(
        "part_id, part_name, method_key, variant_used, session_date, clinical_yield, tolerance, trauma_marker, notes_md, next_step_hint",
      )
      .gte("session_date", sinceDate)
      .order("session_date", { ascending: false });
    if (histErr) throw histErr;
    const history = (histAll ?? []) as HistoryRow[];

    // 3) Pro každou část seskup historii a zapiš balík
    let written = 0;
    let skipped = 0;
    for (const part of partList) {
      const partName = part.name as string;
      const rows = history.filter(
        (r) => (r.part_name ?? "").toLowerCase() === partName.toLowerCase(),
      );
      // Skip prázdné — ať Drive zbytečně nenabobtná u částí, které ještě nikdo nesedl
      if (rows.length === 0) {
        skipped++;
        continue;
      }
      const content = buildPartSection(partName, rows);
      const driveTarget = `KARTA_${partName.toUpperCase()}`;

      const { error: pantryErr } = await supabase
        .from("did_pantry_packages")
        .insert({
          user_id: part.user_id,
          package_type: "part_methods_snapshot",
          content_md: content,
          drive_target_path: driveTarget,
          status: "pending_drive",
          metadata: {
            part_name: partName,
            window_days: WINDOW_DAYS,
            rows_count: rows.length,
            snapshot_date: new Date().toISOString().slice(0, 10),
          },
        });
      if (pantryErr) {
        console.error(`[snapshot] insert failed for ${partName}:`, pantryErr);
        skipped++;
      } else {
        written++;
      }
    }

    return new Response(
      JSON.stringify({
        ok: true,
        parts_total: partList.length,
        parts_written: written,
        parts_skipped: skipped,
        history_rows: history.length,
        duration_ms: Date.now() - startedAt,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("[part-methods-snapshot] fatal:", e);
    return new Response(
      JSON.stringify({ ok: false, error: e instanceof Error ? e.message : "Unknown" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
