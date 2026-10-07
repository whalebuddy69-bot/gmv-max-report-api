// Shared by scheduled and manual syncs. A long initial backfill must not overlap
// a cron sync of the same target in this process. Multi-replica deployments need
// a database/queue lock in addition to this in-process reservation.
const runningTargets = new Set<string>();

export function targetKey(advertiserId: string, storeId: string): string {
  return `${advertiserId}:${storeId}`;
}

export function isTargetRunning(advertiserId: string, storeId: string): boolean {
  return runningTargets.has(targetKey(advertiserId, storeId));
}

export function runningTargetKeys(): string[] {
  return [...runningTargets];
}

export function claimTargetSync(advertiserId: string, storeId: string): boolean {
  const key = targetKey(advertiserId, storeId);
  if (runningTargets.has(key)) return false;
  runningTargets.add(key);
  return true;
}

export function releaseTargetSync(advertiserId: string, storeId: string): void {
  runningTargets.delete(targetKey(advertiserId, storeId));
}
