import { PGlite } from "@electric-sql/pglite";
import { expect, it } from "vitest";
import { CREATOR_BINDING } from "./creatorRead.service";
import { CREATOR_MONITOR_LIMIT, createCreatorMonitorStore, type CreatorMonitorRecord } from "./creatorMonitor.store";

it("persists only the confirming owner's monitor, rejects conflicting rebinding, and bounds the list", async () => {
  const db = new PGlite();
  try {
    const database = { createQueryRunner: () => ({ connect: async () => undefined, release: async () => undefined,
      query: async (sql: string, params?: unknown[]) => sql.includes("CREATE TABLE") ? db.exec(sql) : (await db.query(sql, params)).rows }) };
    const store = createCreatorMonitorStore(database);
    await store.ensureSchema(); await store.ensureSchema();
    const proof: CreatorMonitorRecord = { advertiserId: "98765432123456", campaignId: "98765432123457", tiktokUsername: "demo.live",
      tiktokAccountId: null, identityId: "fixture-identity", identityType: "BC_AUTH_TT",
      identityAuthorizedBcId: CREATOR_BINDING.identityAuthorizedBcId, credentialAdvertiserId: "98765432123456" };
    expect(await store.add(1, proof)).toBe("created");
    expect(await store.add(1, { ...proof, campaignId: "98765432123458" })).toBe("existing");
    expect(await store.add(1, { ...proof, identityId: "other-identity" })).toBe("conflict");
    expect(await createCreatorMonitorStore(database).list(1)).toEqual([proof]);
    expect(await store.list(2)).toEqual([]);
    for (let index = 1; index < CREATOR_MONITOR_LIMIT; index++) {
      expect(await store.add(1, { ...proof, advertiserId: String(98765432123456 + index) })).toBe("created");
    }
    expect(await store.add(1, { ...proof, advertiserId: "98765432876543" })).toBe("limit");
    expect(await store.add(2, proof)).toBe("created");
  } finally { await db.close(); }
}, 20_000);
