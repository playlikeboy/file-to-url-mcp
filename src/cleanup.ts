/** Cron job: deletes expired / download-exhausted files from every tenant's storage and from D1. */

import type { FileRecord, FileStore } from "./store";
import { UploadThingError, type StorageProvider } from "./uploadthing";

const BATCH_SIZE = 100;
/** Keeps one cron run well under the Workers Free limit of 50 subrequests. */
const MAX_BATCHES = 8;

export interface CleanupDeps {
  readonly store: FileStore;
  /** Storage client for an account, or null when its credentials are unknown. */
  readonly storageFor: (tenantId: string) => Promise<StorageProvider | null>;
  readonly now: () => number;
}

interface GroupOutcome {
  /** Files actually deleted from storage. */
  readonly removed: number;
  /** True when the records were left in place to be retried on a later run. */
  readonly retryLater: boolean;
}

function groupByTenant(records: readonly FileRecord[]): ReadonlyMap<string, readonly FileRecord[]> {
  const groups = new Map<string, FileRecord[]>();
  for (const record of records) groups.set(record.tenantId, [...(groups.get(record.tenantId) ?? []), record]);
  return groups;
}

/**
 * Cleans one account's expired files. One account's failure never stops the others: records that can
 * never be deleted (credentials unknown or revoked) are dropped so they cannot block the queue.
 */
async function cleanTenant(deps: CleanupDeps, tenantId: string, records: readonly FileRecord[]): Promise<GroupOutcome> {
  const ids = records.map((record) => record.id);
  try {
    const storage = await deps.storageFor(tenantId);
    if (!storage) {
      console.error(`Cleanup dropped ${records.length} record(s): no credentials for account "${tenantId}".`);
      await deps.store.deleteMany(ids);
      return { removed: 0, retryLater: false };
    }
    await storage.deleteFiles(records.map((record) => record.fileKey));
    await deps.store.deleteMany(ids);
    return { removed: records.length, retryLater: false };
  } catch (error) {
    if (error instanceof UploadThingError && error.isAuthFailure) {
      console.error(`Cleanup dropped ${records.length} record(s): the key for account "${tenantId}" was revoked.`);
      await deps.store.deleteMany(ids);
      return { removed: 0, retryLater: false };
    }
    console.error(`Cleanup failed for account "${tenantId}"; it will be retried.`, error);
    return { removed: 0, retryLater: true };
  }
}

/** Returns how many files were removed from storage. */
export async function cleanupExpired(deps: CleanupDeps): Promise<number> {
  let removed = 0;
  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    const dead = await deps.store.findDead(deps.now(), BATCH_SIZE);
    if (dead.length === 0) break;
    let hasRetries = false;
    for (const [tenantId, records] of groupByTenant(dead)) {
      const outcome = await cleanTenant(deps, tenantId, records);
      removed += outcome.removed;
      hasRetries = hasRetries || outcome.retryLater;
    }
    // Stop when the backlog is drained, or when some records stayed put (the next batch would only repeat them).
    if (dead.length < BATCH_SIZE || hasRetries) break;
  }
  return removed;
}
