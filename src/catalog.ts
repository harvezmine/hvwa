// src/catalog.ts — the machine-readable challenge catalog: the 122 rows of the plan's "Full challenge catalog".
// Data only. A row says what WILL exist; the registry (core/registry.ts) says what does. tools/gen-catalog.ts
// joins the two into docs/CATALOG.md, and tests/catalog.spec.ts keeps them consistent.
import { LEVELS, type Level } from './core/levels.js';

export type { Level };
export type Phase = 1 | 2 | 3 | 4 | 5;

export interface CatalogDistrict {
  /** The registry's district key (kebab-case), as in /d/<key>/<slug>. */
  readonly key: string;
  readonly name: string;
  /** Row count from the plan's table header. */
  readonly count: number;
}

export interface CatalogRow {
  readonly id: string;
  readonly district: CatalogDistrict;
  readonly title: string;
  /** Primary OWASP/standard map, verbatim from the plan. */
  readonly standard: string;
  /** Implemented levels; empty for puzzle challenges (WT-02, WT-03), which have no difficulty tiers. */
  readonly levels: readonly Level[];
  /** Delivery phase 1-5 (Gatekeeper is 1). */
  readonly phase: Phase;
}

export const DISTRICTS: readonly CatalogDistrict[] = Object.freeze([
  Object.freeze({ key: "gatekeeper", name: "Gatekeeper", count: 18 }),
  Object.freeze({ key: "relic-market", name: "Relic Market", count: 14 }),
  Object.freeze({ key: "scriptorium", name: "Scriptorium", count: 20 }),
  Object.freeze({ key: "forum-of-pilgrims", name: "Forum of Pilgrims", count: 12 }),
  Object.freeze({ key: "archive-api", name: "Archive API", count: 15 }),
  Object.freeze({ key: "oracle", name: "Oracle", count: 21 }),
  Object.freeze({ key: "forge", name: "Forge", count: 10 }),
  Object.freeze({ key: "watchtower", name: "Watchtower", count: 7 }),
  Object.freeze({ key: "sanctum", name: "Sanctum", count: 5 }),
]);

const D = Object.fromEntries(DISTRICTS.map((d) => [d.key, d]));

type Raw = readonly [id: string, district: string, title: string, standard: string, levels: string, phase: Phase];

// levels: A=acolyte T=templar I=inquisitor D=divine, "" = puzzle (no tiers)
const RAW: readonly Raw[] = [
  ["GK-01", "gatekeeper", "SQLi login bypass", "A05", "ATID", 1],
  ["GK-02", "gatekeeper", "Brute force, no rate limit", "A07", "ATID", 1],
  ["GK-03", "gatekeeper", "Credential stuffing + `X-Forwarded-For` RL bypass", "A07", "ATID", 1],
  ["GK-04", "gatekeeper", "JWT `alg:none`", "A07", "ATID", 1],
  ["GK-05", "gatekeeper", "JWT HS/RS key confusion", "A07", "ATID", 1],
  ["GK-06", "gatekeeper", "JWT `kid` path traversal", "A07", "ATID", 1],
  ["GK-07", "gatekeeper", "JWT weak secret crack", "A04/A07", "ATID", 1],
  ["GK-08", "gatekeeper", "Password reset predictable token", "A07", "ATID", 1],
  ["GK-09", "gatekeeper", "Password reset host-header poisoning", "A07", "ATID", 1],
  ["GK-10", "gatekeeper", "OAuth `redirect_uri` token theft", "A07", "ATID", 1],
  ["GK-11", "gatekeeper", "OAuth missing `state` (CSRF)", "A07", "ATID", 1],
  ["GK-12", "gatekeeper", "IDOR profile (BOLA)", "A01/API1", "ATID", 1],
  ["GK-13", "gatekeeper", "BFLA hidden admin endpoint", "API5", "ATID", 1],
  ["GK-14", "gatekeeper", "Mass assignment `isAdmin`", "API3", "ATID", 1],
  ["GK-15", "gatekeeper", "OTP/MFA brute force, no lockout", "A07", "ATID", 1],
  ["GK-16", "gatekeeper", "Session fixation", "A07", "ATID", 1],
  ["GK-17", "gatekeeper", "Weak/predictable session ID", "A07", "ATID", 1],
  ["GK-18", "gatekeeper", "Privilege escalation via role cookie", "A01", "ATID", 1],
  ["RM-01", "relic-market", "SQLi product search (UNION)", "A05", "ATID", 2],
  ["RM-02", "relic-market", "Blind boolean SQLi", "A05", "ATID", 2],
  ["RM-03", "relic-market", "Blind time-based SQLi", "A05", "ATID", 2],
  ["RM-04", "relic-market", "NoSQL injection (`$ne` login)", "A05", "ATID", 2],
  ["RM-05", "relic-market", "Negative quantity logic flaw", "A06", "ATID", 2],
  ["RM-06", "relic-market", "Coupon stacking", "A06", "ATID", 2],
  ["RM-07", "relic-market", "Race: coupon reuse", "A06", "AID", 2],
  ["RM-08", "relic-market", "Race: balance underflow (single-packet)", "A06", "AID", 2],
  ["RM-09", "relic-market", "Client-side price manipulation", "A06", "ATID", 2],
  ["RM-10", "relic-market", "Currency rounding abuse", "A06", "ATID", 2],
  ["RM-11", "relic-market", "IDOR order access", "A01/API1", "ATID", 2],
  ["RM-12", "relic-market", "API4 unbounded bulk export", "API4", "ATID", 2],
  ["RM-13", "relic-market", "Workflow skip (pay-step bypass)", "A06", "ATID", 2],
  ["RM-14", "relic-market", "Integer overflow in cart total", "A05", "ATID", 2],
  ["SC-01", "scriptorium", "Reflected XSS (search)", "A05", "ATID", 2],
  ["SC-02", "scriptorium", "Stored XSS (review)", "A05", "ATID", 2],
  ["SC-03", "scriptorium", "DOM XSS (hash router)", "A05", "ATID", 2],
  ["SC-04", "scriptorium", "Markdown renderer XSS", "A05", "ATID", 2],
  ["SC-05", "scriptorium", "SVG upload XSS", "A05", "ATID", 2],
  ["SC-06", "scriptorium", "mXSS sanitizer bypass", "A05", "AID", 2],
  ["SC-07", "scriptorium", "Upload webshell (ext bypass)", "A05", "ATID", 2],
  ["SC-08", "scriptorium", "Upload double-extension", "A05", "ATID", 2],
  ["SC-09", "scriptorium", "Upload polyglot image", "A05", "AID", 2],
  ["SC-10", "scriptorium", "ZIP slip", "A01", "ATID", 2],
  ["SC-11", "scriptorium", "Path traversal download", "A01", "ATID", 2],
  ["SC-12", "scriptorium", "Path traversal Unicode/double-encode", "A01", "AID", 3],
  ["SC-13", "scriptorium", "LFI → log poisoning RCE", "A05", "AID", 3],
  ["SC-14", "scriptorium", "XXE via DOCX", "A05", "ATID", 3],
  ["SC-15", "scriptorium", "XXE via SVG", "A05", "ATID", 3],
  ["SC-16", "scriptorium", "SSRF fetch-from-URL", "A01 (SSRF)", "ATID", 3],
  ["SC-17", "scriptorium", "SSRF → cloud metadata (fake IMDS)", "A01 (SSRF)", "ATID", 3],
  ["SC-18", "scriptorium", "SSRF blacklist bypass (decimal/IPv6)", "A01 (SSRF)", "AID", 3],
  ["SC-19", "scriptorium", "SSRF DNS rebinding", "A01 (SSRF)", "AID", 3],
  ["SC-20", "scriptorium", "Insecure deserialization (`node-serialize`)", "A08", "ATID", 3],
  ["FP-01", "forum-of-pilgrims", "CSRF change email (no token)", "A01", "ATID", 2],
  ["FP-02", "forum-of-pilgrims", "CSRF via JSON content-type", "A01", "ATID", 2],
  ["FP-03", "forum-of-pilgrims", "CORS reflect-origin misconfig", "A05", "ATID", 2],
  ["FP-04", "forum-of-pilgrims", "Clickjacking (no frame headers)", "A05", "ATD", 2],
  ["FP-05", "forum-of-pilgrims", "Stored XSS (bio)", "A05", "ATID", 2],
  ["FP-06", "forum-of-pilgrims", "SSTI (Nunjucks)", "A05", "ATID", 2],
  ["FP-07", "forum-of-pilgrims", "SSTI → RCE", "A05", "AID", 2],
  ["FP-08", "forum-of-pilgrims", "Open redirect (share link)", "A01", "ATID", 2],
  ["FP-09", "forum-of-pilgrims", "IDOR private message (BOLA)", "A01/API1", "ATID", 2],
  ["FP-10", "forum-of-pilgrims", "Second-order SQLi via username", "A05", "AID", 2],
  ["FP-11", "forum-of-pilgrims", "Client-side prototype pollution → XSS", "A05", "AID", 2],
  ["FP-12", "forum-of-pilgrims", "HTML injection in email notification", "A05", "ATID", 2],
  ["AR-01", "archive-api", "GraphQL introspection leak", "API9", "ATD", 3],
  ["AR-02", "archive-api", "GraphQL IDOR via resolver", "API1", "ATID", 3],
  ["AR-03", "archive-api", "GraphQL batching brute force", "API4", "AID", 3],
  ["AR-04", "archive-api", "GraphQL alias-based DoS", "API4", "AID", 3],
  ["AR-05", "archive-api", "GraphQL deep-nesting DoS", "API4", "AID", 3],
  ["AR-06", "archive-api", "GraphQL arg SQL injection", "A05", "ATID", 3],
  ["AR-07", "archive-api", "REST API9 old `/v1` alive", "API9", "ATD", 3],
  ["AR-08", "archive-api", "API mass assignment via PATCH", "API3", "ATID", 3],
  ["AR-09", "archive-api", "BFLA method override (`X-HTTP-Method`)", "API5", "ATID", 3],
  ["AR-10", "archive-api", "Webhook SSRF via callback", "API7", "ATID", 3],
  ["AR-11", "archive-api", "Webhook signature not verified", "A08", "ATID", 3],
  ["AR-12", "archive-api", "API key in client bundle", "A04", "ATD", 3],
  ["AR-13", "archive-api", "API10 unsafe upstream consumption", "API10", "AID", 3],
  ["AR-14", "archive-api", "WebSocket CSWSH", "A01", "ATID", 3],
  ["AR-15", "archive-api", "WebSocket missing per-message authz", "API5", "ATID", 3],
  ["OR-01", "oracle", "Direct prompt injection (leak system prompt)", "LLM01", "ATID", 4],
  ["OR-02", "oracle", "Hidden context / system-prompt exposure", "LLM08", "ATID", 4],
  ["OR-03", "oracle", "Indirect prompt injection (web page)", "LLM01", "ATID", 4],
  ["OR-04", "oracle", "Indirect prompt injection (PDF)", "LLM01", "AID", 4],
  ["OR-05", "oracle", "Cross-modal injection (image alt-text)", "LLM01", "AID", 4],
  ["OR-06", "oracle", "Improper output handling → XSS", "LLM10", "ATID", 4],
  ["OR-07", "oracle", "Improper output handling → SQL", "LLM10", "ATID", 4],
  ["OR-08", "oracle", "Improper output handling → command exec", "LLM10", "AID", 4],
  ["OR-09", "oracle", "Excessive agency: unapproved email send", "LLM03/ASI02", "ATID", 4],
  ["OR-10", "oracle", "Tool misuse: unapproved refund", "ASI02", "ATID", 4],
  ["OR-11", "oracle", "Tool misuse: `run_sql` abuse", "ASI02", "AID", 4],
  ["OR-12", "oracle", "RAG poisoning (malicious doc)", "LLM09", "ATID", 4],
  ["OR-13", "oracle", "Vector DB cross-tenant leak", "LLM09", "AID", 4],
  ["OR-14", "oracle", "Memory poisoning (persistent)", "ASI06", "AID", 4],
  ["OR-15", "oracle", "Unbounded consumption / denial-of-wallet", "LLM06", "ATD", 4],
  ["OR-16", "oracle", "MCP tool poisoning (hidden instruction)", "ASI04", "ATID", 4],
  ["OR-17", "oracle", "MCP rug pull (tool changes post-approval)", "ASI04", "AID", 4],
  ["OR-18", "oracle", "MCP token theft", "ASI02", "AID", 4],
  ["OR-19", "oracle", "Multi-agent A→B injection", "ASI07", "AID", 4],
  ["OR-20", "oracle", "Human-agent trust exploitation", "ASI09", "ATD", 4],
  ["OR-21", "oracle", "Misinformation exploit", "LLM07", "ATD", 4],
  ["FO-01", "forge", "Secrets in exposed `.git`", "A03", "ATD", 4],
  ["FO-02", "forge", "Secrets in `.env`", "A03", "ATD", 4],
  ["FO-03", "forge", "Secret in commit history", "A03", "AID", 4],
  ["FO-04", "forge", "Dependency confusion (internal pkg)", "A03", "AID", 4],
  ["FO-05", "forge", "Typosquat malicious package (benign payload)", "A03", "AID", 4],
  ["FO-06", "forge", "`postinstall` script execution", "A03/A08", "AID", 4],
  ["FO-07", "forge", "CI injection via PR title", "A03", "AID", 4],
  ["FO-08", "forge", "Missing SRI → CDN tamper", "A08", "ATD", 4],
  ["FO-09", "forge", "Unsigned update accepted", "A08", "ATD", 4],
  ["FO-10", "forge", "Mounted Docker socket → escape", "A05", "AID", 4],
  ["WT-01", "watchtower", "Log injection (forge entries)", "A09", "ATID", 5],
  ["WT-02", "watchtower", "Find-the-attacker (log analysis)", "A09", "", 5],
  ["WT-03", "watchtower", "Write a detection rule (tested vs replay)", "A09", "", 5],
  ["WT-04", "watchtower", "Alert bypass (disable logging)", "A09", "AID", 5],
  ["WT-05", "watchtower", "Fail-open exceptional condition", "A10", "AID", 5],
  ["WT-06", "watchtower", "Stack-trace info leak", "A10", "ATD", 5],
  ["WT-07", "watchtower", "ORM error data leak", "A10", "ATD", 5],
  ["SA-01", "sanctum", "HTTP request smuggling (CL.TE)", "A05", "AD", 5],
  ["SA-02", "sanctum", "Web cache poisoning", "A05", "AID", 5],
  ["SA-03", "sanctum", "Web cache deception", "A01", "AID", 5],
  ["SA-04", "sanctum", "Parser differential (JSON dup key)", "A05", "AID", 5],
  ["SA-05", "sanctum", "Unicode normalization auth bypass", "A07", "AID", 5],
];

const LEVEL_BY_LETTER: Readonly<Record<string, Level>> = Object.freeze({ A: LEVELS[0], T: LEVELS[1], I: LEVELS[2], D: LEVELS[3] });

export const CATALOG: readonly CatalogRow[] = Object.freeze(
  RAW.map(([id, district, title, standard, levels, phase]) =>
    Object.freeze({
      id, district: D[district]!, title, standard,
      levels: Object.freeze([...levels].map((c) => LEVEL_BY_LETTER[c]!)),
      phase,
    }),
  ),
);
