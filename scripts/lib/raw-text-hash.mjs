import { createHash } from "node:crypto";

/** sha256 hex of an event's raw_text. Throws on empty. */
export function rawTextHash(rawText) {
  if (rawText == null || String(rawText).trim() === "") {
    throw new Error("rawTextHash: empty raw_text cannot be content-addressed");
  }
  return createHash("sha256").update(String(rawText), "utf8").digest("hex");
}

/** Build the dup_ordinal map for one artwork's events.
 *  Input: [{ sequence, raw_text }, ...]; Returns Map hash → sequences asc. */
export function buildDupOrdinals(events) {
  const bySeq = [...events].sort((a, b) => a.sequence - b.sequence);
  const groups = new Map();
  for (const e of bySeq) {
    const h = rawTextHash(e.raw_text);
    if (!groups.has(h)) groups.set(h, []);
    groups.get(h).push(e.sequence);
  }
  return groups;
}

/** dup_ordinal + dup_count for a (hash, sequence) within an artwork's group map. */
export function dupKey(groups, hash, sequence) {
  const seqs = groups.get(hash) || [];
  const idx = seqs.indexOf(sequence);
  return { dup_ordinal: idx < 0 ? 0 : idx, dup_count: seqs.length || 1 };
}
