import { useEffect, useState, useCallback, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Loader2, ShieldCheck, ShieldAlert, ShieldQuestion, RefreshCw } from "lucide-react";
import { KarelCard } from "@/components/ui/KarelCard";
import { KarelButton } from "@/components/ui/KarelButton";
import { toast } from "sonner";
import {
  type AcceptanceCheck,
  type RunStatus,
} from "@/lib/professionalAcceptanceRegistry";
import { callEdgeFunction } from "@/lib/safeEdgeFunction";

type StoredRun = {
  id: string;
  pass_name: string;
  status: RunStatus;
  generated_at: string;
  checks: AcceptanceCheck[];
  failed_checks: AcceptanceCheck[];
  evidence: Record<string, unknown>;
  app_version: string | null;
};

const STATUS_META: Record<RunStatus, { label: string; icon: typeof ShieldCheck; tone: string }> = {
  accepted: { label: "Přijato", icon: ShieldCheck, tone: "text-emerald-700" },
  not_accepted: { label: "Nepřijato", icon: ShieldAlert, tone: "text-rose-700" },
  partial: { label: "Částečně", icon: ShieldQuestion, tone: "text-amber-700" },
  blocked: { label: "Zablokováno", icon: ShieldAlert, tone: "text-rose-800" },
};

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString("cs-CZ", { dateStyle: "short", timeStyle: "short" });
  } catch {
    return iso;
  }
}

function StatusBadge({ status }: { status: RunStatus }) {
  const meta = STATUS_META[status];
  const Icon = meta.icon;
  return (
    <span className={`inline-flex items-center gap-1.5 text-sm font-medium ${meta.tone}`}>
      <Icon className="h-4 w-4" aria-hidden /> {meta.label}
    </span>
  );
}

function CheckRow({ check }: { check: AcceptanceCheck }) {
  const tone = check.status === "passed"
    ? "text-emerald-700"
    : check.status === "failed" || check.status === "blocked"
      ? "text-rose-700"
      : "text-amber-700";
  return (
    <li className="flex flex-col gap-0.5 py-1.5 border-b border-border/40 last:border-b-0">
      <div className="flex items-center justify-between gap-2 text-sm">
        <span className="font-medium text-foreground">{check.label}</span>
        <span className={`text-xs uppercase tracking-wide ${tone}`}>{check.status}</span>
      </div>
      <div className="text-xs text-muted-foreground">
        <code className="font-mono">{check.id}</code>
        {check.observed !== undefined && (
          <> · pozorováno: <code className="font-mono">{String(check.observed)}</code></>
        )}
        {check.expected && <> · očekáváno: <code className="font-mono">{check.expected}</code></>}
      </div>
      {check.message && (
        <div className="text-xs text-rose-700 mt-0.5">{check.message}</div>
      )}
    </li>
  );
}

function RunCard({ run, onRerun, isRunning }: {
  run: StoredRun | null;
  onRerun: () => void;
  isRunning: boolean;
}) {
  if (!run) {
    return (
      <KarelCard className="p-4">
        <div className="flex items-center justify-between mb-2">
          <h3 className="font-serif text-lg">Žádný záznam</h3>
          <KarelButton size="sm" onClick={onRerun} disabled={isRunning}>
            {isRunning ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            <span className="ml-2">Spustit</span>
          </KarelButton>
        </div>
        <p className="text-sm text-muted-foreground">Zatím nebylo provedeno žádné acceptance vyhodnocení.</p>
      </KarelCard>
    );
  }
  return (
    <KarelCard className="p-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="font-serif text-lg">{run.pass_name}</h3>
          <div className="text-xs text-muted-foreground">
            {formatDate(run.generated_at)}
            {run.app_version && <> · build: <code className="font-mono">{run.app_version}</code></>}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <StatusBadge status={run.status} />
          <KarelButton size="sm" onClick={onRerun} disabled={isRunning}>
            {isRunning ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            <span className="ml-2">Re-run</span>
          </KarelButton>
        </div>
      </div>
      {run.failed_checks.length > 0 && (
        <div className="mb-3 rounded-md border border-rose-300/50 bg-rose-50/40 p-2">
          <div className="text-sm font-semibold text-rose-800 mb-1">Selhané povinné kontroly</div>
          <ul>
            {run.failed_checks.map((c) => <CheckRow key={c.id} check={c} />)}
          </ul>
        </div>
      )}
      <details>
        <summary className="text-sm cursor-pointer text-muted-foreground">
          Všechny kontroly ({run.checks.length})
        </summary>
        <ul className="mt-2">
          {run.checks.map((c) => <CheckRow key={c.id} check={c} />)}
        </ul>
      </details>
    </KarelCard>
  );
}

export default function ProfessionalAcceptancePanel() {
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState<string | null>(null);
  const [latestP1, setLatestP1] = useState<StoredRun | null>(null);
  const [latestP2P3, setLatestP2P3] = useState<StoredRun | null>(null);
  const [latestP6, setLatestP6] = useState<StoredRun | null>(null);
  const [latestP7, setLatestP7] = useState<StoredRun | null>(null);

  const fetchLatest = useCallback(async () => {
    setLoading(true);
    try {
      const result = await callEdgeFunction("karel-acceptance-runner", {
        action: "list_latest",
      });
      const rows = ((result as { runs?: StoredRun[] })?.runs ?? []) as StoredRun[];
      setLatestP1(rows.find((r) => r.pass_name === "P1") ?? null);
      setLatestP2P3(rows.find((r) => r.pass_name === "P2_P3") ?? null);
      setLatestP6(rows.find((r) => r.pass_name === "P6") ?? null);
      setLatestP7(rows.find((r) => r.pass_name === "P7") ?? null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Načtení selhalo");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void fetchLatest(); }, [fetchLatest]);

  const runPass = useCallback(async (passName: "P1" | "P2_P3" | "P6" | "P7") => {
    setRunning(passName);
    try {
      // Client evidence — UI panel cannot itself execute Vitest/DOM proofs;
      // these are confirmed by the CLI runner / test job. The panel can
      // forward whatever the operator manually attests to (default: omit
      // unknowns so the run is reported as `partial` rather than falsely accepted).
      const ev: Record<string, unknown> = {};
      const result = await callEdgeFunction("karel-acceptance-runner", {
        pass_name: passName,
        client_evidence: ev,
      });
      const status = (result as { run?: { status?: RunStatus } })?.run?.status;
      toast[status === "accepted" ? "success" : "warning"](
        `${passName} → ${status ?? "?"}`,
      );
      await fetchLatest();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Acceptance run selhal");
    } finally {
      setRunning(null);
    }
  }, [fetchLatest]);

  const summary = useMemo(() => {
    if (loading) return null;
    if (!latestP1 && !latestP2P3) return "Zatím nejsou žádné záznamy.";
    return null;
  }, [loading, latestP1, latestP2P3]);

  return (
    <div className="max-w-3xl mx-auto p-4 space-y-4">
      <header>
        <h1 className="font-serif text-2xl">Professional Acceptance</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Strukturovaný přehled posledních acceptance vyhodnocení (P1 viditelný text, P2/P3 canonical scope a snapshot guard).
        </p>
      </header>
      {loading ? (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Načítám…
        </div>
      ) : (
        <>
          {summary && <p className="text-sm text-muted-foreground">{summary}</p>}
          <RunCard run={latestP1} onRerun={() => runPass("P1")} isRunning={running === "P1"} />
          <RunCard run={latestP2P3} onRerun={() => runPass("P2_P3")} isRunning={running === "P2_P3"} />
          <div className="pt-2">
            <h2 className="font-serif text-xl mb-2">Operational Coverage &amp; External Reality</h2>
            <p className="text-xs text-muted-foreground mb-2">
              P6 sleduje stav 20 provozních pipeline. P7 sleduje vnější realitu, která může emočně zatížit části (Arthur, Tundrupek, Timmy).
            </p>
          </div>
          <RunCard run={latestP6} onRerun={() => runPass("P6")} isRunning={running === "P6"} />
          <RunCard run={latestP7} onRerun={() => runPass("P7")} isRunning={running === "P7"} />
        </>
      )}
    </div>
  );
}
