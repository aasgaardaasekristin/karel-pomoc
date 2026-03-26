import { useState, useCallback, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "@/hooks/use-toast";

interface DidContextPrimeResult {
  contextBrief: string;
  partCard: string | null;
  systemState: string;
  activePartsLast24h: string[];
  generatedAt: string;
  stats: Record<string, any>;
}

const REPRIME_INTERVAL = 15;

export const useDidContextPrime = () => {
  const [primeCache, setPrimeCache] = useState<string | null>(null);
  const [systemState, setSystemState] = useState<string>("NEZNÁMÝ");
  const [activeParts, setActiveParts] = useState<string[]>([]);
  const [isPriming, setIsPriming] = useState(false);
  const requestIdRef = useRef(0);
  const messagesSincePrime = useRef(0);
  const lastPrimeArgs = useRef<{ partName?: string; subMode?: string }>({});

  const runPrime = useCallback(async (partName?: string, subMode?: string) => {
    lastPrimeArgs.current = { partName, subMode };
    messagesSincePrime.current = 0;
    requestIdRef.current += 1;
    const requestId = requestIdRef.current;

    setIsPriming(true);
    try {
      const { data, error } = await supabase.functions.invoke("karel-did-context-prime", {
        body: { partName, subMode },
      });

      if (requestId !== requestIdRef.current) return null;
      if (error) throw error;
      if (!data) return null;

      const result = data as DidContextPrimeResult;
      setPrimeCache(result.contextBrief);
      setSystemState(result.systemState);
      setActiveParts(result.activePartsLast24h || []);

      console.log(`[DID context-prime] Done: ${result.contextBrief.length} chars, state: ${result.systemState}, parts: ${result.activePartsLast24h?.join(", ")}`);
      return result;
    } catch (e: any) {
      if (requestId !== requestIdRef.current) return null;
      console.error("[DID context-prime] Failed:", e);
      toast({
        title: "Context Prime selhalo",
        description: "Karel se připravuje bez plné cache",
        variant: "destructive",
      });
      return null;
    } finally {
      if (requestId === requestIdRef.current) setIsPriming(false);
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
