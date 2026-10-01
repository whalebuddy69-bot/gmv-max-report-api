import "reflect-metadata";
import { DataSource } from "typeorm";
import { config } from "../config";
import { CampaignDaily } from "../entities/CampaignDaily";
import { CreativeDaily } from "../entities/CreativeDaily";
import { LiveRoomDaily } from "../entities/LiveRoomDaily";
import { OAuthToken } from "../entities/OAuthToken";
import { ProductDaily } from "../entities/ProductDaily";
import { ReportRun } from "../entities/ReportRun";
import { SyncRun } from "../entities/SyncRun";
import { StoreCatalog } from "../entities/StoreCatalog";
import { SyncTarget } from "../entities/SyncTarget";
import { User } from "../entities/User";
import { WebOAuthState } from "../entities/WebOAuthState";

export const AppDataSource = new DataSource({
  type: "postgres",
  host: config.db.host,
  port: config.db.port,
  username: config.db.username,
  password: config.db.password,
  database: config.db.database,
  // managed Postgres uses a self-signed CA
  ssl: config.db.ssl ? { rejectUnauthorized: false } : false,
  entities: [
    OAuthToken,
    ReportRun,
    SyncTarget,
    StoreCatalog,
    SyncRun,
    CampaignDaily,
    ProductDaily,
    CreativeDaily,
    LiveRoomDaily,
    User,
    WebOAuthState,
  ],
  // Keep false: the database is shared with the telegram bot and OAuthToken is only a
  // partial mapping. Schema changes go through sql/.
  synchronize: false,
  logging: false,
});
