/** Cron job: deletes expired / download-exhausted files from every tenant's storage and from D1. */

import type { FileRecord, FileStore } from "./store";
import type { StorageProvider } from "./uploadthing";

const BATCH_SIZE = 100;
/** Keeps one cron run well under the Workers Free limit of 50 subrequests. */
const MAX_BATCHES = 8;

export interface CleanupDeps {
  readonly store: FileStore;
  /** Storage client for an app, or null when its credentials are unknown. */
  readonly storageFor: (appId: string) => Promise<StorageProvider | null>;
  readonly now: () => number;
}

function groupByApp(records: readonly FileRecord[]): ReadonlyMap<string, readonly FileRecord[]> {
  const groups = new Map<string, FileRecord[]>();
  for (const record of records) groups.set(record.appId, [...(groups.get(record.appId) ?? []), record]);
  return groups;
}

/** Returns how many files were removed. Files whose account is unknown are left for a later run. */
export async function cleanupExpired(deps: CleanupDeps): Promise<number> {
  let removed = 0;
  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    const dead = await deps.store.findDead(deps.now(), BATCH_SIZE);
    if (dead.length === 0) break;
    let removedInBatch = 0;
    for (const [appId, records] of groupByApp(dead)) {
      const storage = await deps.storageFor(appId);
      if (!storage) {
        console.error(`Cleanup skipped ${records.length} file(s): no credentials for app "${appId}".`);
        continue;
      }
      await storage.deleteFiles(records.map((record) => record.fileKey));
      await deps.store.deleteMany(records.map((record) => record.id));
      removedInBatch += records.length;
    }
    removed += removedInBatch;
    // Stop when the backlog is drained, or when this batch made no progress (it would only repeat).
    if (dead.length < BATCH_SIZE || removedInBatch < dead.length) break;
  }
  return removed;
}
