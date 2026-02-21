import fs from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "./db.js";

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

export class UsageStats {
  private data: StatsData;
  private dirty = false;
  private readonly filePath: string;
  private readonly timer: NodeJS.Timeout;

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

  /** Write to disk if there are pending changes. Sync write (<1 KB file). */
  flush(): void {
    if (!this.dirty) return;

    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const tmp = this.filePath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.filePath);
    this.dirty = false;
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
