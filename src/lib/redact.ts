/**
 * Central secret redaction. Applied to logs, stored run output, error messages,
 * and AI inputs before anything leaves the process.
 */

const PATTERNS: Array<{ name: string; re: RegExp; replace: string }> = [
  // TestSprite / sk-style API keys
  { name: "api_key", re: /\b(sk[-_][A-Za-z0-9_-]{8,}|ts[-_]live[-_][A-Za-z0-9_-]{8,})/gi, replace: "sk-***REDACTED***" },
  // GitHub tokens
  { name: "github_token", re: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, replace: "gh***_***REDACTED***" },
  { name: "github_pat", re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, replace: "github_pat_***REDACTED***" },
  // Bearer / authorization headers
  { name: "auth_header", re: /(authorization\s*[:=]\s*)(Bearer\s+)?[A-Za-z0-9._+/=-]{10,}/gi, replace: "$1***REDACTED***" },
  // Generic key=value secrets
  {
    name: "kv_secret",
    re: /\b(api[_-]?key|secret|token|password|passwd|pwd)(\s*[:=]\s*)(["']?)[A-Za-z0-9._+/=-]{8,}\3/gi,
    replace: "$1$2$3***REDACTED***",
  },
  // AWS access keys
  { name: "aws_key", re: /\bAKIA[0-9A-Z]{16}\b/g, replace: "AKIA***REDACTED***" },
];

export function redact(input: string): string {
  let out = input;
  for (const { re, replace } of PATTERNS) {
    out = out.replace(re, replace as never);
  }
  return out;
}

/** Truncate stored output to a cap, with a visible marker. */
export function truncateOutput(input: string, capBytes = 256 * 1024): { text: string; truncated: boolean } {
  if (Buffer.byteLength(input, "utf8") <= capBytes) return { text: input, truncated: false };
  const cut = Buffer.from(input, "utf8").subarray(0, capBytes).toString("utf8");
  return { text: `${cut}\n--- OUTPUT TRUNCATED AT ${capBytes} BYTES ---`, truncated: true };
}
