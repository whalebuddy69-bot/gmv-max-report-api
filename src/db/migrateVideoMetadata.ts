import fs from "fs/promises";
import path from "path";
import { AppDataSource } from "./dataSource";

async function main(): Promise<void> {
  await AppDataSource.initialize();
  try {
    // Deliberately only the new additive migration, not historical shared-DB SQL.
    const sql = await fs.readFile(path.resolve(__dirname, "../../sql/011_video_metadata.sql"), "utf8");
    await AppDataSource.transaction(async (manager) => {
      await manager.query("SET LOCAL lock_timeout = '5s'");
      await manager.query("SET LOCAL statement_timeout = '30s'");
      await manager.query("SELECT pg_advisory_xact_lock(hashtext('report_video_metadata_migration'))");
      await manager.query(sql);
    });
    console.log("Video metadata migration applied");
  } finally {
    await AppDataSource.destroy();
  }
}

main().catch(() => {
  console.error("Video metadata migration failed; deployment must not continue");
  process.exitCode = 1;
});
