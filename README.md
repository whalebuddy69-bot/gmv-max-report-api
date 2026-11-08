# gmv-max-report-api

API ดึงรายงาน GMV Max จาก TikTok Business API มาเก็บใน Postgres เป็นข้อมูลรายวัน ให้หน้าเว็บ (gmv-max-report-web) เรียกใช้ และ export เป็น Excel ได้

ใช้ database เดียวกับ gmv-max-telegram-bot (ตาราง `oauth_tokens`, `creators`)

Node 20, Express, TypeORM, Postgres

## รัน

```
npm install
cp .env.example .env
npm run dev
```

ก่อนรันครั้งแรกต้องสร้างตารางก่อน รันไฟล์ใน `sql/` ตามลำดับเลข

```
for f in sql/*.sql; do psql "$DATABASE_URL" -f "$f"; done
```

สร้าง user สำหรับ login หน้าเว็บ

```
npm run create-user -- admin@example.com รหัสผ่าน "ชื่อ" admin
```

production ใช้ `npm run build` แล้ว `npm start`

## env

ดูทั้งหมดใน `.env.example` ตัวที่ต้องระวัง

- `DATABASE_URL` หรือ `DB_*` ถ้ามี `DATABASE_URL` จะใช้ตัวนี้
- `TOKEN_ENCRYPTION_KEY` ต้องเป็นค่าเดียวกับของ telegram bot ไม่งั้นถอดรหัส token ไม่ได้
- `JWT_SECRET` ยาว 32 ตัวขึ้นไป
- `INTERNAL_API_KEY` ใช้กับ `/stores` `/reports` `/sync` ส่งมาใน header `x-api-key` ถ้าไม่ตั้งจะเรียกได้เลยโดยไม่ต้องมี key
- `CORS_ORIGINS` โดเมนของหน้าเว็บ คั่นด้วย comma
- `TIKTOK_APP_ID` `TIKTOK_APP_SECRET` `TIKTOK_OAUTH_REDIRECT_URI` `WEB_APP_URL` ใช้กับปุ่มขอสิทธิ์ร้านบนเว็บ ต้องตั้งครบ 4 ตัว และ redirect uri ต้องตรงกับที่ตั้งใน TikTok developer portal
- `SYNC_ENABLED` เปิด sync อัตโนมัติ ถ้ารันหลายเครื่องให้เปิดเครื่องเดียว

## API

ฝั่งเว็บ ต้อง login ก่อนแล้วส่ง `Authorization: Bearer <token>`

```
POST   /auth/login
GET    /auth/me
POST   /auth/change-password
GET    /users                      (admin)
POST   /users
PATCH  /users/:id
POST   /users/:id/password
DELETE /users/:id

GET    /analytics/stores
GET    /analytics/summary
GET    /analytics/timeseries
GET    /analytics/campaigns
GET    /analytics/products
GET    /analytics/creators
GET    /analytics/creatives
GET    /analytics/live-rooms
GET    /analytics/live-rooms/export
GET    /analytics/all
GET    /analytics/all/export
GET    /analytics/campaign-options
GET    /analytics/creator-options
GET    /analytics/store-authorization
POST   /analytics/store-authorization/authorize-link
```

query ที่ใช้เหมือนกันเกือบทุกตัวคือ `from` `to` (YYYY-MM-DD), `storeId` (ใส่หลายร้านคั่นด้วย comma ได้) และ `promotionType` (PRODUCT, LIVE, ALL)

ฝั่ง internal ส่ง `x-api-key`

```
GET    /stores?advertiserId=
POST   /reports/generate
GET    /reports/:id/download
GET    /sync/status
POST   /sync/discover
POST   /sync/run
PATCH  /sync/targets/:id
```

อื่นๆ `GET /health` กับ `GET /oauth/tiktok/callback` (TikTok redirect กลับมา)

## sync

cron (ตั้งที่ `SYNC_CRON`) จะหาร้านจาก token ที่มี แล้ว upsert ลงตาราง `report_*_daily` ผลแต่ละรอบดูได้ที่ตาราง `sync_runs` หรือ `GET /sync/status`

- ร้านใหม่ที่ยังไม่มีการ sync สำเร็จ (`last_synced_at IS NULL`) เริ่มจาก **วันที่ 1 ของเดือนก่อนหน้า ถึงวันนี้** ตาม timezone ของบัญชี เช่น 7 ต.ค. 2026 ดึง 1 ก.ย.–7 ต.ค. 2026
- ร้านที่เคย sync สำเร็จแล้วดึงช่วงสั้นตาม `SYNC_LOOKBACK_DAYS` เช่น 3 วัน เพื่ออัปเดตตัวเลขล่าสุด ไม่ดึงประวัติยาวซ้ำทุกชั่วโมง
- แบ่งช่วงยาวเป็นคำขอช่วงละไม่เกิน 30 วันแบบรวมต้น/ปลายและไม่ซ้อนกัน บันทึกหนึ่ง `sync_runs` พร้อมยอดรวม row counts ทั้งรอบ ถือว่าสำเร็จและเปลี่ยน `last_synced_at` ต่อเมื่อทุกช่วงสำเร็จ ถ้าร้านใหม่ล้มเหลวให้ retry ช่วงเริ่มต้นทั้งหมดได้โดย upsert ไม่เพิ่มข้อมูลซ้ำ
- `runningTargets` รวมทั้ง manual และ cron เพื่อกันการดึงร้านเดียวกันซ้อนใน process เดียว Production หลาย replicas ต้องเพิ่ม distributed lock ก่อนขยายระบบ

ถ้าจะดึงย้อนหลังมากกว่านั้นให้ยิง `POST /sync/run` ทีละร้าน

```
{ "advertiserId": "...", "storeId": "...", "lookbackDays": 30 }
```

หรือขอให้เริ่มวันที่ 1 เดือนก่อนหน้า แม้ร้านเคย sync ช่วงสั้นไปแล้ว:

```
{ "advertiserId": "...", "storeId": "...", "initialHistory": true }
```

`lookbackDays` รับ 1–62 วันและต้องระบุร้านเดียว; ใช้ร่วมกับ `initialHistory: true` ไม่ได้ คำขอไม่ระบุร้านและไม่ระบุ history options ยังหมายถึง sync ทุกร้านตาม policy เดิม/ใหม่ของแต่ละร้าน ไม่อนุญาตส่ง ID มาเพียงตัวเดียวแล้วกลายเป็นดึงทุกร้านโดยไม่ตั้งใจ

HTTP 202 ตอบ `range: { startDate, endDate }` ของงานที่รับไว้ ไม่ใช่ยืนยันว่าดึงสำเร็จ ตรวจผลสุดท้ายจาก `/sync/status` ช่วงที่ขอดึงไม่รับประกันว่ามีข้อมูลทุกวัน: TikTok อาจส่งกลับเฉพาะวันที่มีข้อมูล และระบบไม่สร้างยอดศูนย์แทนวันที่ API ไม่ส่งมา

ร้านที่เคย sync สำเร็จด้วย policy 3 วันก่อนการเปลี่ยนนี้จะไม่ถูก backfill ทั้งหมดอัตโนมัติ ให้เลือกย้อนหลัง 30 วัน/วันที่ 1 เดือนก่อนรายร้านตามต้องการ การ retry explicit history ที่ล้มเหลวสำหรับร้านเดิมต้องส่ง history option เดิมอีกครั้ง

## deploy

ตอนนี้รันบน Railway ต่อกับ Postgres ใน project เดียวกัน ตั้ง env ตามด้านบน build ด้วย `npm run build` start ด้วย `npm start` อย่าลืมรัน sql ก่อน

## Creator username / post-date metadata

- `sql/011_video_metadata.sql` adds only `report_video_metadata`; it does not change daily ad metrics or shared bot tables.
- Configure Railway service Settings > Deploy > Pre-deploy Command as `npm run migrate:video-metadata` (set on production on 2026-10-02). Do not rely on `railway.toml`: the current Railway API rejects legacy Config as Code and directs users to Infrastructure as Code. Verify the migration success log and a successful `/analytics/creatives` response before deploying the web app. For other hosts run the command after building and before starting the new API. A missing optional metadata table leaves enrichment null without taking the financial report offline; investigate the warning and apply the migration.
- After each successful store sync, a separate bounded background job checks up to 50 distinct known video IDs. It covers historical known videos, not just the rolling three-day performance window. Jobs are queued; failures do not fail the ad-report sync.
- Username comes from TikTok's public oEmbed `author_url`, accepted only when the returned video ID matches. A product card never receives a username. Names are not used as join keys.
- Post time, when available, is the explicit `createTime` in the matching public TikTok post's structured page data. This is **not an Ads API contract**. Store UTC `posted_at` with source `tiktok_public_page`; page changes, private/deleted posts, challenges, redirects, or rate limits leave it unavailable. No ID-derived date or first-ad date is substituted.
- Successful metadata is cached for seven days. Partial results retry after one day, unavailable results after six hours. A temporary failure preserves earlier verified values. Background jobs are serialized, two reads run concurrently within a store, and 403/429 stops that store's batch.
- An active admin can enqueue a one-store refresh with `POST /analytics/video-metadata/refresh`, body `{ "storeId": "7495637369664014736", "limit": 200 }`. Limit is 1–500, with a bounded time budget; repeat only after the previous job has finished if more unknown videos remain. Runtime logs report counts, not secrets or response bodies.
- `/analytics/creatives` adds nullable `tt_account_username`, `video_posted_at`, and `video_posted_at_source`. Old performance values are untouched. The frontend displays username after the existing display-name column, including exports.

### Counting videos posted in a period

Do not reuse `stat_date` or the current `total_videos` KPI: they describe ad-performance days, not publication. Deduplicate by `item_id` (one video can appear against several products or days), convert period boundaries from Asia/Bangkok to UTC, then apply `[from 00:00, day-after-to 00:00)` to `posted_at`. Always show known-date coverage and unknown counts. The current discovery universe contains only videos present in synced GMV Max reports; it cannot claim to count every shop-linked post, especially posts with no report activity. A complete shop-wide count needs a separate shop/affiliate video inventory and permission check.

Rollback: deploy the prior API/web versions; leave the additive metadata table in place. Do not drop it or run destructive rollback SQL.

## Creative inventory and latest known delivery status

- Sync retains valid creative rows returned by TikTok even when cost, orders and impressions are zero or unknown. Missing metrics stay null. Product cards (`item_id = -1`) remain separate from videos. This does not turn the report API into a complete shop video inventory: videos/dates omitted upstream cannot be manufactured.
- Existing discarded rows are recovered only when their reporting dates are synced again. The regular rolling sync does not automatically backfill all history.
- Delivery KPI cards, daily video counts and creator rankings retain their former activity rule: a row must have positive cost, orders or product impressions. Zero-only inventory appears in creative details but must not inflate “Videos advertised”.
- `/analytics/creatives` sums metrics only inside the selected performance range. Independently, `creative_delivery_status` comes from the newest stored report day for the exact `(store_id, campaign_id, item_group_id, item_id)` context, ordered by `stat_date DESC, synced_at DESC`. A later backfill of an older day cannot replace the newer report day. Pagination uses stable identity tie-breakers.
- Nullable `creative_delivery_status_checked_at` is the source row's sync timestamp; `creative_delivery_status_stat_date` is its reporting date (`YYYY-MM-DD`). Neither is TikTok's status-change time. A newest row with a missing status stays unknown rather than borrowing an older value. This is the latest **known stored** delivery status, not a live-status guarantee or a historical status as of the selected end date.
- Delivery status is not TikTok's Exploration/Outstanding classification. No quality or scale recommendation is inferred from it.
- No new database migration is required. Status lookups reuse the existing creative primary key. `analytics.creatives.sql.test.ts` exercises the production SQL against an isolated in-memory PostgreSQL runtime (PGlite, dev dependency only); tests never connect to production.

### Delivery status filters and refresh cadence

- Optional `/analytics/creatives?deliveryStatus=...` accepts the exact nine TikTok values `IN_QUEUE`, `LEARNING`, `DELIVERING`, `NOT_DELIVERYING`, `AUTHORIZATION_NEEDED`, `EXCLUDED`, `UNAVAILABLE`, `REJECTED`, `NOT_ACTIVE`, plus `UNKNOWN` and `OTHER`. Invalid/repeated values return HTTP 400. Omit it for all statuses.
- Null/whitespace/`-`/`0`/`-1` classify as `UNKNOWN`; future raw codes classify as `OTHER` and remain unchanged in rows. Known codes are case-sensitive.
- Status filtering happens on the latest stored observation after period aggregation and before pagination. It never filters individual daily performance rows by their historical status. Response `statusCounts` contains all eleven numeric keys including zeros, honoring the other filters but ignoring deliveryStatus, limit and offset. Counts represent `(store, campaign, product, video)` contexts, not unique shop videos; product cards are included unless contentType excludes them.
- Counts and rows use two read queries plus optional metadata enrichment. No new TikTok requests, cron change, mutation or migration is introduced. Large concurrent exports repeat scope counts per page; measure database load before adding cache or a combined snapshot.
- Production cadence remains hourly (`0 * * * *`). Dashboard refresh reads saved data, not TikTok. Source-report `synced_at` is our observation time, not the upstream status-change time; rolling-window sync does not refresh contexts omitted by TikTok.
- Do not enable aggressive polling without app-wide quota coordination: current upstream limiter is per advertiser/process whereas [TikTok limits](https://business-api.tiktok.com/portal/docs/rate-limits/v1.3) are developer-app global/endpoint scoped. Add daily quota tracking, appropriate rate-limit cooldown, and distributed coordination before scaling replicas. `sync_runs.apiCalls` counts logical report calls, not every physical page/retry; it is not an exact billing or quota meter.

## Creator Automation: web operator pilot

The web budget workflow for Ppan and the separately configured Srihiw pilot does not enable autonomous optimization. Each mode is disabled by default. The existing report/Creator viewer grant and a separate explicit operator grant are both required to prepare, confirm, or save a cap. A bearer session is revalidated at the boundary. POST requests require the exact report site origin, JSON, and a bounded body. An operation ID never grants access by itself, and Srihiw's routes, OAuth token, policy lease and durable operation records are separate from Ppan's.

The control service stores one authoritative policy per Creator. An operator saves a cap on the website using the last observed revision; the change updates both limits for that Creator only. Srihiw has no default: the owner creates its first cap at revision 0. Saving a cap is not a TikTok operation. The report server reads the policy through a fixed server-to-server URL and a separately provisioned secret, never from a browser value or a cached fallback. Simulated confirmation checks a fresh Creator snapshot, exact campaign/budget/fingerprint, same Bangkok day, complete spend, both caps and the short proposal expiry, then records `SIMULATED` without acquiring a provider send lease. It rejects targets at or below observed spend. All amounts use THB minor units until converting the single provider budget field.

Ppan live manual confirmation requires `CREATOR_WEB_BUDGET_MODE=live`; Srihiw requires its own verified registry binding, `CREATOR_WEB_SRIHIW_BUDGET_MODE=live` and `CREATOR_WEB_SRIHIW_BUDGET_LIVE_ENABLED=true`. Both require the global `CREATOR_WEB_BUDGET_LIVE_ENABLED=true`, the legacy dated writer disabled, their own current cap and a current operation-bound policy lease on the control service. Before the single POST, the app re-reads spend, campaign/budget/stamp and revalidates the operator. It never retries the provider POST. Success requires code zero plus two stable exact readbacks; ambiguous responses retain the durable fence. No campaign start/pause, ROI edit, or Auto write is enabled here.

**Supervised canary and recovery.** Pick one Creator, verify native Auto Budget is off in Ads Manager and that no operator or automation will edit the campaign during the test. The endpoint has no verified atomic compare-and-swap; do not treat API `UNKNOWN` as verified off. The operator confirms the exact reviewed change, then checks the original operation status. On timeout, reload that operation, never submit again. On an unresolved result, preserve both durable locks, record the original operation ID, owner, campaign and time from the protected ledger, and compare the provider campaign change history and two fresh scoped reads with the requested amount and baseline. Escalate unresolved or conflicting evidence for manual review; this release does not offer a fence-clear or an automatic retry. Do not edit the ledger or unlock on elapsed time alone. Repeat the supervised test for the other Creator only after the first result is understood.

### Auto budget shadow and supervised pilot

`CREATOR_AUTO_BUDGET_MODE=shadow` shows an advisory Ppan calculation in the Automation row. It uses the latest reported Bangkok-day spend and actual current budget: threshold `80%`, target `120%`, subject to both caps (exact satang, no clamp). The calculation is not execution authority. Srihiw, nnshop5719 and ashopbytheta have exact, independent scopes; no Creator inherits another's caps, ledger, pilot state, OAuth or LINE recipient. Their optional shadow settings are `CREATOR_AUTO_BUDGET_SRIHIW_MODE=shadow`, `CREATOR_AUTO_BUDGET_NNSHOP5719_MODE=shadow`, and `CREATOR_AUTO_BUDGET_ASHOPBYTHETA_MODE=shadow`. A missing cap is never filled by default; the authorized operator can set it from the row without changing TikTok.

Ppan uses a separate continuous session: it has no count or time limit and is bound to the exact active campaign and independently verified LIVE room, owner, cap revision, and provider readback fingerprint. It never transfers to a new room/campaign. After each verified write and idempotent LINE handoff, the next operation requires a later provider spend watermark and the new exact readback fingerprint. The target is rounded down by less than one satang if needed, never above +20%, and is still rejected rather than clamped if it exceeds either cap. Verified LIVE end, disappearance/replacement, cap or external baseline change, revoked authority and operator Stop end the session. Missing/ambiguous evidence blocks writes. An ambiguous provider outcome keeps its fence even after Stop. Ppan also requires `CREATOR_AUTO_BUDGET_PPAN_CONTINUOUS_LIVE_ENABLED=true`; never set it until the approved upstream watermark and active LIVE-room proof are integrated. Legacy Ppan one-shot grants can reconcile only and cannot send through the replacement route.

Ppan-only opt-in: `CREATOR_AUTO_BUDGET_PPAN_SPEND_TREND_LIVE_ENABLED=true` allows the authorized operator to arm a continuous session using the same campaign's increasing spend between consecutive minute reads. It does not enable other Creators, prove current LIVE delivery, or declare native Auto disabled. It does not send on a flat, regressing, unreadable or missing sample, or when a native Auto conflict is positively identified. No reporting observation survives a restart or an uncertain operation. A verified external budget change with no pending operation resets the sample baseline; verified LIVE end or campaign replacement still stops. Both caps, final scope and budget checks, provider readback, and LINE handoff remain mandatory. TikTok reporting may update retroactively, including after a LIVE.

An exact spend-trend attempt that was conclusively `NOT_SENT` is retained for audit and may release its baseline for a later two-sample check. This is not a provider retry: unresolved/ambiguous results and prior verified mutations never release their fences, and a stopped session does not reactivate itself.

Srihiw can opt into its own exact spend-trend route with `CREATOR_AUTO_BUDGET_SRIHIW_SPEND_TREND_LIVE_ENABLED=true` in addition to its verified Creator binding and live manual writer. It uses a separate session/attempt ledger and a separate Render cap and explicit LINE recipient authorization. Its 120% target must be exactly representable in satang; no cap clamp, unscoped account, or fallback recipient. This does not enable other Creators or any previous one-shot grant.

Ppan operator diagnostics show the last completed scheduler tick and valid read, hold reason, exact Auto outcomes, and notification acceptance when verified by the protected control-service lookup. A separate read-only watchdog bridge reports sustained failures or missing ticks; notification delivery does not grant any budget authority.

Other Creators retain the isolated one-shot pilot, with an expiry of at most two hours and one attempt per Creator/Bangkok day. Both strategies require verified fresh upstream spend, LIVE delivery, native Auto OFF, and a scoped ready LINE recipient. The windows start when armed, not at a scheduled time. When the verified threshold is reached the system sends a real budget update without a second confirmation. The existing per-Creator durable ledger and policy lease serialize against manual commands. After an uncertain provider write, do not resend or release the fence on timeout. A confirmed ledger may retry only the idempotent notification bridge, never TikTok. Do not enable the automatic live switches for the current adapter: the integrated Creator reporting payload has no verified spend watermark or active-delivery proof. A successful web request is not a spend timestamp. Confirm no-Shop Creator support and permissions for TikTok's Automated Rules before replacing these guards.

### Additional Creator rows (read-only)

`CREATOR_AUTOMATION_EXTRA_READ_CLIENTS` is a server-only array of `{clientId,displayName,advertiserId,tiktokAccountId}`; it adds an authorized dashboard row, not an advertising write permission. `CREATOR_AUTOMATION_VERIFIED_READ_BINDINGS` is a separate array of `{clientId,advertiserId,tiktokAccountId,identityId,identityType,identityAuthorizedBcId}` whose metadata must match that row exactly. Provision only after proving the advertiser's current OAuth access, currency/day scope, the Creator's verified TikTok identity in that advertiser, and an unambiguous Creator no-Shop LIVE campaign. The extra numeric account ID remains user-supplied unless independently verified. Do not check in customer tuples or OAuth secrets.

`GET /automation/performance/:clientId` selects a server-configured read adapter after session and viewer checks. It never accepts external advertiser/campaign IDs or dates. The legacy `/automation/performance` route remains the Ppan alias. Currency other than THB, unverified dates, incomplete campaign pages, multiple enabled candidates, and wrong identity fail closed rather than selecting a guessed campaign. Extra adapters cannot be selected by the budget routes, cap bridge or LINE writer.
