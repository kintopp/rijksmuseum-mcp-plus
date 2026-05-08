import fs from "node:fs";

// Memory observability for issue #272 — captures process RSS breakdown,
// per-DB SQLite pragma state, and (on Linux) per-DB mmap'd resident bytes
// from /proc/self/smaps. Used for the startup log line and the
// /debug/memory HTTP endpoint.

export interface DbPragmaInfo {
  name: string;
  filePath: string | null;
  pageCount: number;
  pageSize: number;
  dbSizeBytes: number;
  mmapSizeBytes: number;
  cacheSizeRaw: number;      // PRAGMA cache_size (negative = -KB, positive = pages)
  cacheSizeBytes: number;
  smapsResidentBytes: number | null; // null on non-Linux or if file not mapped
}

export interface MemorySnapshot {
  timestamp: string;
  uptimeSeconds: number;
  process: {
    rssBytes: number;
    heapTotalBytes: number;
    heapUsedBytes: number;
    externalBytes: number;
    arrayBuffersBytes: number;
  };
  vm: {
    vmRssBytes: number;
    vmDataBytes: number;
    vmSizeBytes: number;
  } | null;
  databases: DbPragmaInfo[];
}

interface PragmaQueryable {
  pragma(name: string, opts?: { simple?: boolean }): unknown;
}

export interface DbHandle {
  name: string;
  schema?: string;         // SQLite schema name, default "main"
  filePath: string | null; // resolved disk path; used for smaps lookup
  db: PragmaQueryable | null;
}

function safePragma(db: PragmaQueryable, name: string): number | null {
  try {
    const v = db.pragma(name, { simple: true });
    return typeof v === "number" ? v : (typeof v === "bigint" ? Number(v) : null);
  } catch {
    return null;
  }
}

function readVmStats(): MemorySnapshot["vm"] {
  if (process.platform !== "linux") return null;
  try {
    const txt = fs.readFileSync("/proc/self/status", "utf-8");
    const get = (key: string): number => {
      const m = txt.match(new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, "m"));
      return m ? parseInt(m[1], 10) * 1024 : 0;
    };
    return {
      vmRssBytes: get("VmRSS"),
      vmDataBytes: get("VmData"),
      vmSizeBytes: get("VmSize"),
    };
  } catch {
    return null;
  }
}

// Parse /proc/self/smaps once and sum Rss values for each requested file path.
// smaps format: each region begins with `<addr>-<addr> <perms> <off> <dev> <inode> <path>`
// followed by `Rss: <kB> kB` (and many other fields). Same file may appear in
// multiple regions if mapped non-contiguously; sum them.
function readSmapsResident(filePaths: string[]): Map<string, number> {
  const result = new Map<string, number>();
  if (process.platform !== "linux" || filePaths.length === 0) return result;
  // On Linux, initialize each requested file to 0 so a file present but with
  // no faulted-in pages reports 0 (truly resident) rather than null (unmeasurable).
  for (const p of filePaths) result.set(p, 0);

  let txt: string;
  try {
    txt = fs.readFileSync("/proc/self/smaps", "utf-8");
  } catch {
    return result;
  }

  const pathSet = new Set(filePaths);
  let currentPath: string | null = null;
  let currentMatched = false;

  for (const line of txt.split("\n")) {
    if (/^[0-9a-f]+-[0-9a-f]+\s/.test(line)) {
      // Region header — extract trailing path (last whitespace-separated field)
      const fields = line.split(/\s+/);
      const last = fields[fields.length - 1];
      currentPath = last && last.startsWith("/") ? last : null;
      currentMatched = currentPath !== null && pathSet.has(currentPath);
    } else if (currentMatched && line.startsWith("Rss:")) {
      const m = line.match(/Rss:\s+(\d+)\s*kB/);
      if (m && currentPath) {
        result.set(currentPath, (result.get(currentPath) ?? 0) + parseInt(m[1], 10) * 1024);
      }
    }
  }
  return result;
}

export function captureMemorySnapshot(handles: DbHandle[]): MemorySnapshot {
  const mu = process.memoryUsage();

  const filesToProbe = handles
    .map(h => h.filePath)
    .filter((p): p is string => typeof p === "string");
  const smapsByFile = readSmapsResident(filesToProbe);

  const databases: DbPragmaInfo[] = handles.map(h => {
    if (!h.db) {
      return {
        name: h.name,
        filePath: h.filePath,
        pageCount: 0,
        pageSize: 0,
        dbSizeBytes: 0,
        mmapSizeBytes: 0,
        cacheSizeRaw: 0,
        cacheSizeBytes: 0,
        smapsResidentBytes: h.filePath ? (smapsByFile.get(h.filePath) ?? null) : null,
      };
    }
    const schema = h.schema ?? "main";
    const prefix = schema === "main" ? "" : `${schema}.`;
    const pageCount = safePragma(h.db, `${prefix}page_count`) ?? 0;
    const pageSize = safePragma(h.db, `${prefix}page_size`) ?? 0;
    const mmapSize = safePragma(h.db, `${prefix}mmap_size`) ?? 0;
    const cacheRaw = safePragma(h.db, `${prefix}cache_size`) ?? 0;
    const cacheBytes = cacheRaw < 0 ? Math.abs(cacheRaw) * 1024 : cacheRaw * pageSize;
    const smapsRes = h.filePath ? (smapsByFile.get(h.filePath) ?? null) : null;
    return {
      name: h.name,
      filePath: h.filePath,
      pageCount,
      pageSize,
      dbSizeBytes: pageCount * pageSize,
      mmapSizeBytes: mmapSize,
      cacheSizeRaw: cacheRaw,
      cacheSizeBytes: cacheBytes,
      smapsResidentBytes: smapsRes,
    };
  });

  return {
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    process: {
      rssBytes: mu.rss,
      heapTotalBytes: mu.heapTotal,
      heapUsedBytes: mu.heapUsed,
      externalBytes: mu.external,
      arrayBuffersBytes: mu.arrayBuffers,
    },
    vm: readVmStats(),
    databases,
  };
}

function mb(n: number): string {
  return (n / (1024 * 1024)).toFixed(1);
}

// Multi-line startup log with full per-DB breakdown
export function formatMemorySnapshotDetailed(snap: MemorySnapshot): string {
  const lines: string[] = [];
  const p = snap.process;
  lines.push(`Memory snapshot at ${snap.timestamp} (uptime ${snap.uptimeSeconds}s):`);
  lines.push(`  process: rss=${mb(p.rssBytes)}MB heapTotal=${mb(p.heapTotalBytes)}MB heapUsed=${mb(p.heapUsedBytes)}MB external=${mb(p.externalBytes)}MB arrayBuffers=${mb(p.arrayBuffersBytes)}MB`);
  if (snap.vm) {
    lines.push(`  /proc/self/status: VmRSS=${mb(snap.vm.vmRssBytes)}MB VmData=${mb(snap.vm.vmDataBytes)}MB VmSize=${mb(snap.vm.vmSizeBytes)}MB`);
  }
  for (const d of snap.databases) {
    const smaps = d.smapsResidentBytes !== null ? ` mmapResident=${mb(d.smapsResidentBytes)}MB` : "";
    lines.push(`  db[${d.name}]: dbSize=${mb(d.dbSizeBytes)}MB mmapCap=${mb(d.mmapSizeBytes)}MB cache=${mb(d.cacheSizeBytes)}MB${smaps}`);
  }
  return lines.join("\n");
}
