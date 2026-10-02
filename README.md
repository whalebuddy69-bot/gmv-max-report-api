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

cron (ตั้งที่ `SYNC_CRON`) จะหาร้านจาก token ที่มี แล้วดึงข้อมูลย้อนหลัง `SYNC_LOOKBACK_DAYS` วันของทุกร้านมา upsert ลงตาราง `report_*_daily` ผลแต่ละรอบดูได้ที่ตาราง `sync_runs` หรือ `GET /sync/status`

ถ้าจะดึงย้อนหลังมากกว่านั้นให้ยิง `POST /sync/run` ทีละร้าน

```
{ "advertiserId": "...", "storeId": "...", "lookbackDays": 30 }
```

สูงสุด 30 วัน

## deploy

ตอนนี้รันบน Railway ต่อกับ Postgres ใน project เดียวกัน ตั้ง env ตามด้านบน build ด้วย `npm run build` start ด้วย `npm start` อย่าลืมรัน sql ก่อน

## Creator username / post-date metadata

- `sql/011_video_metadata.sql` adds only `report_video_metadata`; it does not change daily ad metrics or shared bot tables.
- Railway runs `npm run migrate:video-metadata` before deploying this version. Deploy the API before the web app. For other hosts run this command after building and before starting the new API.
- After each successful store sync, a separate bounded background job checks up to 50 distinct known video IDs. It covers historical known videos, not just the rolling three-day performance window. Jobs are queued; failures do not fail the ad-report sync.
- Username comes from TikTok's public oEmbed `author_url`, accepted only when the returned video ID matches. A product card never receives a username. Names are not used as join keys.
- Post time, when available, is the explicit `createTime` in the matching public TikTok post's structured page data. This is **not an Ads API contract**. Store UTC `posted_at` with source `tiktok_public_page`; page changes, private/deleted posts, challenges, redirects, or rate limits leave it unavailable. No ID-derived date or first-ad date is substituted.
- Successful metadata is cached for seven days. Partial results retry after one day, unavailable results after six hours. A temporary failure preserves earlier verified values. Background jobs are serialized, two reads run concurrently within a store, and 403/429 stops that store's batch.
- An active admin can enqueue a one-store refresh with `POST /analytics/video-metadata/refresh`, body `{ "storeId": "7495637369664014736", "limit": 200 }`. Limit is 1–500, with a bounded time budget; repeat only after the previous job has finished if more unknown videos remain. Runtime logs report counts, not secrets or response bodies.
- `/analytics/creatives` adds nullable `tt_account_username`, `video_posted_at`, and `video_posted_at_source`. Old performance values are untouched. The frontend displays username after the existing display-name column, including exports.

### Counting videos posted in a period

Do not reuse `stat_date` or the current `total_videos` KPI: they describe ad-performance days, not publication. Deduplicate by `item_id` (one video can appear against several products or days), convert period boundaries from Asia/Bangkok to UTC, then apply `[from 00:00, day-after-to 00:00)` to `posted_at`. Always show known-date coverage and unknown counts. The current discovery universe contains only videos present in synced GMV Max reports; it cannot claim to count every shop-linked post, especially posts with no report activity. A complete shop-wide count needs a separate shop/affiliate video inventory and permission check.

Rollback: deploy the prior API/web versions; leave the additive metadata table in place. Do not drop it or run destructive rollback SQL.
