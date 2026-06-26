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
 *
 * DEPRECATION NOTE: the JSON copy exists only for hosts that cannot surface
 * structuredContent to the model. The *global* opt-in for it (JSON_TEXT_COMPAT /
 * MCP_TEXT_JSON_COMPAT, helpers.ts) is a compat shim slated for removal once
 * claude.ai / Claude Desktop read structuredContent. The per-call
 * jsonText/jsonTextData options below stay live (paginatedResponse full records,
 * citation tools).
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
  /**
   * When present, THIS object is serialized into the text-channel JSON copy
   * instead of `data`, while the full `data` still rides on structuredContent.
   * Lets a tool send a trimmed/answer-shaped summary to text-only LLM hosts
   * (claude.ai/Desktop) while keeping the full payload for structuredContent
   * readers (the CLI). See find_similar (plan json-text-compat-rollout §E).
   */
  jsonTextData?: object;
}

/** Documented per-result ceiling for claude.ai / Claude Desktop (characters). */
export const PLATFORM_RESULT_CHAR_CEILING = 150_000;

/**
 * Keep the whole result this far under the platform ceiling (20% headroom).
 * Headroom covers JSON-RPC framing and the unknown — the docs don't say whether
 * the ceiling counts structuredContent, so we assume it does and stay well below.
 * Derived from PLATFORM_RESULT_CHAR_CEILING so the two move together if the
 * platform limit changes (and so the ceiling constant is not a dead export).
 */
export const SAFE_RESULT_BUDGET = Math.round(PLATFORM_RESULT_CHAR_CEILING * 0.8);

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
  /**
   * Byte length of the structuredContent payload when it DIFFERS from the text
   * copy (i.e. the caller passed jsonTextData, so structuredContent carries a
   * fuller object than the text block). When omitted, the guard assumes
   * structuredContent ≈ the text copy — the common case where both serialize
   * the same `data`.
   */
  structuredPayloadBytes?: number;
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
  // the text copy roughly doubles the structured payload's contribution — UNLESS
  // the caller diverged the two (jsonTextData), in which case use the actual
  // (larger) structuredContent size so the projected-total guard stays honest.
  const structuredBytes = opts.structuredContentEmitted
    ? (opts.structuredPayloadBytes ?? copyBytes)
    : 0;
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

/**
 * Mirror the shared `warnings` convention (a `string[]` on the response payload,
 * used by the search-family tools) into the human text channel with a unified
 * `⚠ ` prefix. This is the SINGLE place warnings reach `content[].text`; tool
 * handlers MUST NOT append `⚠ ` lines themselves (that double-renders).
 *
 * - `humanText === undefined` → returned unchanged (the JSON-only legacy path
 *   already serializes `warnings` inside the object).
 * - `data.warnings` absent / not an array / empty → `humanText` unchanged.
 * - otherwise → the warning lines are appended after a blank-line separator so
 *   they stand visually apart from the result body.
 *
 * Pure + payload-tolerant: reads `warnings` off an unknown object and ignores it
 * unless it is a non-empty array. Generic enough to live beside the block
 * builder; deliberately NOT folded into `buildContentBlocks`, which stays
 * payload-shape-agnostic.
 */
export function mirrorWarningsToText(
  data: unknown,
  humanText: string | undefined,
): string | undefined {
  if (humanText === undefined) return humanText;
  const w = (data as { warnings?: unknown }).warnings;
  if (!Array.isArray(w) || w.length === 0) return humanText;
  const block = w.map(x => `⚠ ${x}`).join("\n");
  return humanText ? `${humanText}\n\n${block}` : block;
}
