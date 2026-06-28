const MESSAGES: Record<string, string> = {
  verify_failed: "We couldn't find the TXT record, or its value didn't match. DNS can take a few minutes — make sure it's live, then verify again.",
  expired: "That code expired. Restart to get a fresh one.",
  domain_conflict: "This domain is already verified on another account.",
  invalid_site: "Enter a valid, public domain (no localhost or private addresses).",
  unknown_nonce: "That code is no longer valid. Restart to get a fresh one.",
  rate_limited: "Too many attempts. Wait a minute, then try again.",
};
export function provisionErrorMessage(code: string): string {
  return MESSAGES[code] ?? "Something went wrong. Check your domain and try again.";
}
