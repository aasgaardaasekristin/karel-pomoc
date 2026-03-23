import { toast } from "@/hooks/use-toast";

/**
 * Checks a Drive edge-function response for token / auth errors
 * and shows a user-friendly toast instead of crashing.
 * Returns true if the response indicates a Drive auth failure.
 */
export function handleDriveError(
  res: { error?: any; data?: any } | null | undefined,
  silent = false
): boolean {
  const errorMsg: string =
    res?.data?.error || res?.error?.message || res?.error || "";

  const isDriveAuthError =
    /invalid_grant|expired|revoked|Missing Google OAuth/i.test(errorMsg);

  if (isDriveAuthError) {
    if (!silent) {
      toast({
        title: "⚠️ Google Drive připojení selhalo",
        description:
          "Refresh token vypršel nebo byl odvolán. Kontaktuj administrátora pro obnovení přístupu.",
        variant: "destructive",
        duration: 10000,
      });
    }
    console.error("[Drive Auth] Token error:", errorMsg);
    return true;
  }

  return false;
}
