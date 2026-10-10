import { readFile, writeFile } from "node:fs/promises";
import { logInfo, logWarn } from "./log.js";

// Idle page-cache release. Railway bills cgroup memory, which includes the
// kernel page cache over the DB files; after a burst of queries that cache sits
// at several GB for hours. Once the server has been idle for `idleMs`, ask the
// kernel to reclaim this cgroup's file-backed pages via cgroup v2
// `memory.reclaim`. The cost is a cold first query afterwards.

const CGROUP_DIR = "/sys/fs/cgroup";
const CHECK_INTERVAL_MS = 60_000;
const MIN_FILE_BYTES = 64 * 1024 * 1024; // not worth a reclaim below this

export interface IdleReclaimStatus {
  enabled: boolean;
  idleMinutes: number;
  lastActivityAt: string;
  lastReclaim: { at: string; fileBytesBefore: number; currentBefore: number; currentAfter: number } | null;
  disabledReason: string | null;
}

async function readCgroupNumber(file: string): Promise<number | null> {
  try {
    const n = Number((await readFile(`${CGROUP_DIR}/${file}`, "utf-8")).trim());
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

async function readFileBytes(): Promise<number | null> {
  try {
    const stat = await readFile(`${CGROUP_DIR}/memory.stat`, "utf-8");
    const m = stat.match(/^file (\d+)$/m);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

async function writeReclaim(bytes: number): Promise<void> {
  const path = `${CGROUP_DIR}/memory.reclaim`;
  try {
    // swappiness=0 keeps reclaim to file pages; older kernels reject the key.
    await writeFile(path, `${bytes} swappiness=0`);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EINVAL") await writeFile(path, String(bytes));
    else throw err;
  }
}

export function startIdleReclaim(idleMs: number): { touch(): void; status(): IdleReclaimStatus } {
  let lastActivity = Date.now();
  let reclaimedSinceActivity = false;
  let running = false;
  let disabledReason: string | null = process.platform === "linux" ? null : "not linux";
  let lastReclaim: IdleReclaimStatus["lastReclaim"] = null;

  const reclaim = async (): Promise<void> => {
    const fileBefore = await readFileBytes();
    const currentBefore = await readCgroupNumber("memory.current");
    if (fileBefore === null || currentBefore === null) {
      disabledReason = "cgroup v2 memory stats unavailable";
      logWarn("Idle memory release disabled: cgroup v2 memory stats unavailable");
      return;
    }
    if (fileBefore < MIN_FILE_BYTES) return;
    try {
      await writeReclaim(fileBefore);
    } catch (err) {
      // EAGAIN = reclaimed less than requested, which is expected (some cache is in active use).
      if ((err as NodeJS.ErrnoException).code !== "EAGAIN") {
        disabledReason = `memory.reclaim not writable (${(err as NodeJS.ErrnoException).code ?? "error"})`;
        logWarn("Idle memory release disabled: memory.reclaim not writable", err);
        return;
      }
    }
    const currentAfter = (await readCgroupNumber("memory.current")) ?? currentBefore;
    lastReclaim = { at: new Date().toISOString(), fileBytesBefore: fileBefore, currentBefore, currentAfter };
    logInfo(`Idle memory release: cgroup ${Math.round(currentBefore / 1048576)}MB -> ${Math.round(currentAfter / 1048576)}MB`, lastReclaim);
  };

  if (!disabledReason) {
    setInterval(() => {
      if (disabledReason || running || reclaimedSinceActivity || Date.now() - lastActivity < idleMs) return;
      running = true;
      reclaimedSinceActivity = true;
      reclaim().finally(() => { running = false; });
    }, CHECK_INTERVAL_MS).unref();
  }

  return {
    touch() {
      lastActivity = Date.now();
      reclaimedSinceActivity = false;
    },
    status: () => ({
      enabled: disabledReason === null,
      idleMinutes: idleMs / 60_000,
      lastActivityAt: new Date(lastActivity).toISOString(),
      lastReclaim,
      disabledReason,
    }),
  };
}
