const MESSAGES: Record<string, string> = {
  verify_failed: "We couldn't read the file, or its contents didn't match. Make sure it's live at the exact URL, then verify again.",
  expired: "That code expired. Restart to get a fresh one.",
  domain_conflict: "This domain is already verified on another account.",
  invalid_site: "Enter a valid, public domain (no localhost or private addresses).",
  unknown_nonce: "That code is no longer valid. Restart to get a fresh one.",
  rate_limited: "Too many attempts. Wait a minute, then try again.",
};
export function provisionErrorMessage(code: string): string {
  return MESSAGES[code] ?? "Something went wrong. Check your domain and try again.";
}
