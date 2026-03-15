import { useState, useCallback, useRef } from "react";
import { getAuthHeaders } from "@/lib/auth";
import { toast } from "@/hooks/use-toast";

interface DidContextPrimeResult {
  contextBrief: string;
  partCard: string | null;
  systemState: string;
  activePartsLast24h: string[];
  generatedAt: string;
  stats: Record<string, any>;
}

export const useDidContextPrime = () => {
  const [primeCache, setPrimeCache] = useState<string | null>(null);
  const [systemState, setSystemState] = useState<string>("NEZNÁMÝ");
  const [activeParts, setActiveParts] = useState<string[]>([]);
  const [isPriming, setIsPriming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const runPrime = useCallback(async (partName?: string, subMode?: string) => {
    // Abort any in-flight prime
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setIsPriming(true);
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-did-context-prime`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ partName, subMode }),
          signal: controller.signal,
        }
      );

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Unknown" }));
        console.error("[DID context-prime] Error:", err);
        return null;
      }

      const data: DidContextPrimeResult = await res.json();
      setPrimeCache(data.contextBrief);
      setSystemState(data.systemState);
      setActiveParts(data.activePartsLast24h || []);

      console.log(`[DID context-prime] Done: ${data.contextBrief.length} chars, state: ${data.systemState}, parts: ${data.activePartsLast24h?.join(", ")}`);
      return data;
    } catch (e: any) {
      if (e.name === "AbortError") return null;
      console.error("[DID context-prime] Failed:", e);
      toast({
        title: "Context Prime selhalo",
        description: "Karel se připravuje bez plné cache",
        variant: "destructive",
      });
      return null;
    } finally {
      setIsPriming(false);
    }
  }, []);

  return {
    primeCache,
    systemState,
    activeParts,
    isPriming,
    runPrime,
  };
};
