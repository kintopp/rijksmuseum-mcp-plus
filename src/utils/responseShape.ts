/**
 * Build the `content` text blocks for a tool response, with an optional
 * machine-readable serialized-JSON fallback (MCP 2025-11-25 backwards-compat:
 * a tool returning structuredContent SHOULD also expose serialized JSON in a
 * TextContent block). Pure + env-free so it is unit-testable; the env gate and
 * the structuredContent decision live in registration.ts and are passed in.
 *
 * Size guard (two-tier): the JSON copy is the change most likely to push a
 * result over the host's per-result ceiling (claude.ai/Desktop ~150,000 chars;
 * Claude Code ~25,000 tokens). The copy is appended only when (a) it is within
 * the per-copy cap AND (b) the PROJECTED TOTAL result — human summary + JSON
 * copy + the structuredContent the SDK also attaches — stays under
 * SAFE_RESULT_BUDGET. Otherwise a tiny marker is emitted instead of a copy.
 */

export type TextBlock = {
  type: "text";
  text: string;
  /**
   * MCP content annotations (spec-conformant routing hints). Set ONLY on
   * two-block results so a host can tell the primary human summary from the
   * secondary JSON/marker block without relying on block order. Single-block
   * results carry no annotations (default path stays byte-identical).
   */
  annotations?: { audience?: ("user" | "assistant")[]; priority?: number };
};

/** Per-call options exposed to tool handlers via structuredResponse. */
export interface JsonTextOptions {
  /**
   * Force-append (true) or suppress (false) the serialized-JSON block for this
   * call, overriding the global default. Used by source/citation tools that
   * must always expose parseable JSON (see Plan 024 search/fetch).
   */
  jsonText?: boolean;
  /** Per-copy cap override (defaults to DEFAULT_JSON_TEXT_BUDGET). */
  maxJsonTextBytes?: number;
}

/** Documented per-result ceiling for claude.ai / Claude Desktop (characters). */
export const PLATFORM_RESULT_CHAR_CEILING = 150_000;

/**
 * Keep the whole result this far under the platform ceiling. Headroom covers
 * JSON-RPC framing and the unknown — the docs don't say whether the ceiling
 * counts structuredContent, so we assume it does and stay well below.
 */
export const SAFE_RESULT_BUDGET = 120_000;

/** Conservative per-copy default: ~20 KB of serialized JSON in the text block. */
export const DEFAULT_JSON_TEXT_BUDGET = 20_000;

/** Resolved inputs to the pure builder (caller combines per-call opts + env). */
export interface BuildBlocksOptions {
  /** Resolved decision: append the JSON copy? (per-call opt OR'd with global flag). */
  jsonText: boolean;
  /** Per-copy cap override (defaults to DEFAULT_JSON_TEXT_BUDGET). */
  maxJsonTextBytes?: number;
  /** Whether structuredContent will ALSO ride on this result (≈ same serialized bytes). */
  structuredContentEmitted: boolean;
}

/**
 * - `humanText === undefined` → single block of pretty-printed JSON (legacy
 *   behavior; the JSON is already the only text, so no second block).
 * - `humanText` present → block[0] is the human summary, verbatim. A SECOND
 *   block of compact `JSON.stringify(data)` is appended only when
 *   `opts.jsonText` is true AND the copy is within the per-copy cap AND the
 *   projected total result stays under SAFE_RESULT_BUDGET. Otherwise a tiny
 *   marker block is appended instead (never an oversized copy).
 *
 * Two-block results carry MCP content annotations so spec-conformant hosts can
 * route without relying on order: block[0] (human) is marked primary
 * (priority 1, audience user+assistant); the JSON/marker block is marked
 * secondary (priority 0, NO audience — see the inversion footgun in the body).
 *
 * The two are always SEPARATE blocks — JSON is never concatenated into the
 * human block.
 */
export function buildContentBlocks(
  data: unknown,
  humanText: string | undefined,
  opts: BuildBlocksOptions,
): TextBlock[] {
  if (humanText === undefined) {
    return [{ type: "text", text: JSON.stringify(data, null, 2) }];
  }

  const blocks: TextBlock[] = [{ type: "text", text: humanText }];
  if (!opts.jsonText) return blocks;

  // Two-block result: annotate so spec-conformant hosts route without relying on
  // block order — human block is primary, JSON/marker block is secondary.
  // FOOTGUN: do NOT set audience:["assistant"] on the JSON block. A host that
  // routes assistant-audience to the model and user-audience to display would
  // then feed the model JSON and show the user prose — inverting the intent.
  blocks[0].annotations = { audience: ["user", "assistant"], priority: 1 };

  const serialized = JSON.stringify(data);
  const copyBytes = Buffer.byteLength(serialized, "utf8");
  const humanBytes = Buffer.byteLength(humanText, "utf8");
  const perCopyCap = opts.maxJsonTextBytes ?? DEFAULT_JSON_TEXT_BUDGET;
  // structuredContent (when attached) ≈ the same serialized payload, so adding
  // the text copy roughly doubles the structured payload's contribution.
  const structuredBytes = opts.structuredContentEmitted ? copyBytes : 0;
  const projectedTotal = humanBytes + copyBytes + structuredBytes;

  if (copyBytes <= perCopyCap && projectedTotal <= SAFE_RESULT_BUDGET) {
    blocks.push({ type: "text", text: serialized, annotations: { priority: 0 } });
  } else {
    // Do NOT duplicate. Emit a marker so a text-only client knows schema-conformant
    // data exists (in structuredContent) but was elided to respect size limits.
    blocks.push({
      type: "text",
      text: JSON.stringify({
        jsonTextFallback: "omitted",
        reason: copyBytes > perCopyCap ? "exceeds_copy_cap" : "exceeds_result_ceiling",
        bytes: copyBytes,
        perCopyCap,
        projectedResultBytes: projectedTotal,
        resultBudget: SAFE_RESULT_BUDGET,
      }),
      annotations: { priority: 0 },
    });
  }

  return blocks;
}
