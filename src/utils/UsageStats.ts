import fs from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "./db.js";
import { lruGetOrCreate } from "./lru.js";

interface ToolStats {
  calls: number;
  errors: number;
  totalMs: number;
  maxMs: number;
}

interface DailyStats {
  calls: number;
  errors: number;
}

export interface StatsData {
  since: string;
  lastUpdated: string;
  tools: Record<string, ToolStats>;
  daily: Record<string, DailyStats>;
}

// ── Slow-query instrumentation (in-memory only; never persisted) ───────────
// Per-(tool, canonical input) and per-(tool, phase) latency with coarse
// histogram percentiles, so the always-on process stays O(buckets) per entry.
// `record()`/`toJSON()`/`flush()` and the persisted StatsData are unchanged.

const LATENCY_BUCKETS_MS = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000, 30_000];
const MAX_INPUTS_PER_TOOL = 200;

interface LatencyHist {
  count: number;
  max: number;
  buckets: number[]; // length LATENCY_BUCKETS_MS.length + 1 (last = overflow)
}

function newHist(): LatencyHist {
  return { count: 0, max: 0, buckets: new Array(LATENCY_BUCKETS_MS.length + 1).fill(0) };
}
function histAdd(h: LatencyHist, ms: number): void {
  h.count++;
  if (ms > h.max) h.max = ms;
  let i = LATENCY_BUCKETS_MS.findIndex(b => ms <= b);
  if (i < 0) i = LATENCY_BUCKETS_MS.length;
  h.buckets[i]++;
}
/** Approximate percentile: upper bound of the crossing bucket, or exact max for the overflow bin. */
function histPercentile(h: LatencyHist, p: number): number {
  if (h.count === 0) return 0;
  const target = Math.ceil(p * h.count);
  let cum = 0;
  for (let i = 0; i < h.buckets.length; i++) {
    cum += h.buckets[i];
    if (cum >= target) return i < LATENCY_BUCKETS_MS.length ? LATENCY_BUCKETS_MS[i] : h.max;
  }
  return h.max;
}

export interface SlowQuerySnapshot {
  perInput: Record<string, Array<{ input: string; count: number; repeats: number; p50: number; p90: number; max: number }>>;
  phases: Record<string, Record<string, { count: number; p50: number; p90: number; max: number }>>;
}

export class UsageStats {
  private data: StatsData;
  private dirty = false;
  private readonly filePath: string;
  private readonly timer: NodeJS.Timeout;
  // tool → (canonical input → hist). Inner Map is insertion-order LRU, capped per tool.
  private perInput = new Map<string, Map<string, LatencyHist>>();
  // tool → (phase → hist). Phase names are few (main/facets/embed/scan) → naturally bounded.
  private perPhase = new Map<string, Map<string, LatencyHist>>();

  constructor(filePath?: string) {
    this.filePath =
      filePath ??
      process.env.USAGE_STATS_PATH ??
      path.join(PROJECT_ROOT, "data", "usage-stats.json");

    this.data = this.load();

    // Flush every hour; .unref() so it won't keep the process alive
    this.timer = setInterval(() => this.flush(), 3_600_000);
    this.timer.unref();
  }

  /** Record a single tool call. No I/O -- just updates memory + dirty flag. */
  record(tool: string, ms: number, ok: boolean): void {
    const now = new Date().toISOString();

    const t = this.data.tools[tool] ??= { calls: 0, errors: 0, totalMs: 0, maxMs: 0 };
    t.calls++;
    if (!ok) t.errors++;
    t.totalMs += ms;
    if (ms > t.maxMs) t.maxMs = ms;

    const day = now.slice(0, 10);
    const d = this.data.daily[day] ??= { calls: 0, errors: 0 };
    d.calls++;
    if (!ok) d.errors++;

    this.data.lastUpdated = now;
    this.dirty = true;
  }

  /** Record latency keyed by canonical tool input (in-memory; not persisted). */
  recordInput(tool: string, inputKey: string, ms: number): void {
    let m = this.perInput.get(tool);
    if (!m) { m = new Map(); this.perInput.set(tool, m); }
    histAdd(lruGetOrCreate(m, inputKey, newHist, MAX_INPUTS_PER_TOOL), ms);
  }

  /** Record a phase timing within a tool call (e.g. "main"/"facets", "embed"/"scan"). */
  recordPhase(tool: string, phase: string, ms: number): void {
    let m = this.perPhase.get(tool);
    if (!m) { m = new Map(); this.perPhase.set(tool, m); }
    let h = m.get(phase);
    if (!h) { h = newHist(); m.set(phase, h); }
    histAdd(h, ms);
  }

  /** Snapshot of slow-query instrumentation for /debug/slow-queries. */
  slowQueries(topPerTool = 20): SlowQuerySnapshot {
    const perInput: SlowQuerySnapshot["perInput"] = {};
    for (const [tool, m] of this.perInput) {
      const rows = [...m.entries()].map(([input, h]) => ({
        input,
        count: h.count,
        repeats: Math.max(0, h.count - 1),
        p50: histPercentile(h, 0.5),
        p90: histPercentile(h, 0.9),
        max: Math.round(h.max),
      }));
      rows.sort((a, b) => b.max - a.max);
      perInput[tool] = rows.slice(0, topPerTool);
    }
    const phases: SlowQuerySnapshot["phases"] = {};
    for (const [tool, m] of this.perPhase) {
      const obj: Record<string, { count: number; p50: number; p90: number; max: number }> = {};
      for (const [phase, h] of m) {
        obj[phase] = { count: h.count, p50: histPercentile(h, 0.5), p90: histPercentile(h, 0.9), max: Math.round(h.max) };
      }
      phases[tool] = obj;
    }
    return { perInput, phases };
  }

  /** Write to disk if there are pending changes. Sync write (<1 KB file). */
  flush(): void {
    if (!this.dirty) return;

    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      const tmp = this.filePath + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.filePath);
      this.dirty = false;
    } catch (err) {
      console.error("[UsageStats] flush failed:", err);
    }
  }

  /** Return current stats snapshot (for potential /health enrichment). */
  toJSON(): StatsData {
    return this.data;
  }

  private load(): StatsData {
    try {
      const raw = fs.readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.since === "string" && parsed.tools && parsed.daily) {
        return parsed as StatsData;
      }
    } catch {
      // Missing or corrupt -- start fresh
    }
    const now = new Date().toISOString();
    return { since: now, lastUpdated: now, tools: {}, daily: {} };
  }
}
