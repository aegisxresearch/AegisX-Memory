/**
 * Secret detection — single source of truth (RFC §5, STRIDE:I).
 *
 * One module, two compiled regexes:
 *  - TOKEN_PATTERN: high-confidence credential token shapes (prefix-anchored,
 *    so false-positive rate on ordinary code is negligible).
 *  - ASSIGNMENT_PATTERN: key=value assignments whose key names a credential —
 *    catches `password=…`, `api_key=…`, `authorization: Bearer …` even when the
 *    value has no recognizable prefix.
 *
 * Consumers:
 *  - Indexer: per-LINE redaction while extracting symbols (indexer.ts).
 *  - Engine.remember / Engine.saveSession: whole-VALUE refusal at storage time
 *    (engine.ts) — the handoff path is stored verbatim, so it must be scanned.
 */

/** High-confidence credential tokens. Prefix-anchored: cheap, near-zero FPs. */
const TOKEN_PATTERN_SOURCE = [
  'sk-[A-Za-z0-9]{20,}',                    // OpenAI-style
  'ghp_[A-Za-z0-9]{36,}',                   // GitHub classic PAT
  'github_pat_[A-Za-z0-9_]{20,}',           // GitHub fine-grained PAT
  'AKIA[0-9A-Z]{16}',                       // AWS access key id
  'xox[baprs]-[A-Za-z0-9-]{10,}',           // Slack token
  'AIza[0-9A-Za-z\\-_]{35}',                // Google API key
  'npm_[A-Za-z0-9]{36}',                    // npm publish token
  'eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.', // JWT (header.payload.)
  '-----BEGIN [A-Z ]*PRIVATE KEY-----',     // PEM key material
  '[A-Za-z][A-Za-z0-9+.-]{1,15}://[^\\s/:@]+:[^\\s/@]+@', // URL-embedded creds: scheme://user:pass@
];

/** Credential-named assignments: `password=…`, `API_KEY: …`, `Bearer …`. */
const ASSIGNMENT_PATTERN_SOURCE =
  '(?:password|passwd|pwd|secret|token|api[_-]?key|auth|authorization|credential[s]?|private[_-]?key)' +
  '\\s*[:=]\\s*\\S';

/** Full detection pattern: tokens OR credential-named assignments.
 *  Case-insensitive so `API_KEY=` and `Password:` are caught; false positives
 *  (e.g. refusing a fact phrased "auth: use JWT") are the safe failure mode —
 *  the user rephrases, no secret is ever stored. One pattern for every
 *  consumer: Engine refusals and Indexer per-line redaction stay in lockstep. */
const SECRET_PATTERN = new RegExp(`${TOKEN_PATTERN_SOURCE.join('|')}|${ASSIGNMENT_PATTERN_SOURCE}`, 'i');

/**
 * True if the value contains a credential-shaped token or a credential-named
 * assignment. Used by Engine to refuse storing user-supplied values.
 */
export function containsSecret(value: string): boolean {
  return SECRET_PATTERN.test(value);
}

/**
 * True if the line carries a secret. Same pattern as containsSecret — kept as
 * a distinct name for call-site intent (per-line redaction vs whole-value).
 * Used by the Indexer before symbol extraction.
 */
export function lineContainsSecret(line: string): boolean {
  return SECRET_PATTERN.test(line);
}
