import { NotFoundError } from "../utils/errors";
import { logger } from "../utils/logger";
import { Store, StoreContext, TikTokApiService } from "./tiktokApi.service";
import { getAccessTokenForAdvertiser } from "./token.service";

export interface StoreSummary {
  storeId: string;
  storeName: string;
  storeCode?: string;
  isGmvMaxAvailable: boolean;
  storeAuthorizedBcId?: string;
  bcName?: string;
  storeStatus?: string;
  regionCodes?: string[];
  /** The only ad account that can run GMV Max for this shop. */
  exclusiveAdvertiserId?: string;
  exclusiveAdvertiserName?: string;
}

export function toStoreSummary(store: Store): StoreSummary {
  return {
    storeId: store.store_id,
    storeName: store.store_name ?? store.store_id,
    storeCode: store.store_code,
    isGmvMaxAvailable: store.is_gmv_max_available === true,
    storeAuthorizedBcId: store.store_authorized_bc_id,
    bcName: store.store_authorized_bc_info?.bc_name,
    storeStatus: store.store_status,
    regionCodes: store.targeting_region_codes,
    exclusiveAdvertiserId: store.exclusive_authorized_advertiser_info?.advertiser_id,
    exclusiveAdvertiserName: store.exclusive_authorized_advertiser_info?.advertiser_name,
  };
}

/** Shops for an advertiser, GMV-Max-available ones first. Backs GET /stores. */
export async function listStoresForAdvertiser(advertiserId: string): Promise<StoreSummary[]> {
  const accessToken = await getAccessTokenForAdvertiser(advertiserId);
  const api = new TikTokApiService(accessToken, advertiserId);
  const stores = await api.listStores();

  return stores
    .map(toStoreSummary)
    .sort((a, b) =>
      a.isGmvMaxAvailable === b.isGmvMaxAvailable
        ? a.storeName.localeCompare(b.storeName)
        : Number(b.isGmvMaxAvailable) - Number(a.isGmvMaxAvailable)
    );
}

export interface ResolvedStore {
  context: StoreContext;
  storeName: string;
  warnings: string[];
}

/** Looks up the store via the API; an unknown storeId fails with the list of valid ids. */
export async function resolveStore(
  api: TikTokApiService,
  params: { advertiserId: string; storeId: string; storeAuthorizedBcId?: string }
): Promise<ResolvedStore> {
  const stores = await api.listStores();
  const store = stores.find((s) => s.store_id === params.storeId);

  if (!store) {
    throw new NotFoundError(
      `advertiser ${params.advertiserId} เข้าถึง store ${params.storeId} ไม่ได้, ` +
        `ร้านที่ใช้ได้: ${stores.map((s) => `${s.store_name ?? "?"} (${s.store_id})`).join(", ") || "ไม่มีเลย"}`,
      { advertiserId: params.advertiserId, storeId: params.storeId, availableStores: stores.length }
    );
  }

  // An explicit override still wins, useful if TikTok ever returns a stale BC id.
  const bcId = params.storeAuthorizedBcId ?? store.store_authorized_bc_id;
  if (!bcId) {
    throw new NotFoundError(
      `store ${params.storeId} ไม่มี store_authorized_bc_id จาก /gmv_max/store/list/, ` +
        `ส่ง storeAuthorizedBcId มาใน request body`,
      { storeId: params.storeId }
    );
  }

  const warnings: string[] = [];
  const exclusive = store.exclusive_authorized_advertiser_info;

  // A different advertiser returns all-zero rows instead of an error, so warn about it.
  if (exclusive?.advertiser_id && exclusive.advertiser_id !== params.advertiserId) {
    warnings.push(
      `⚠️ ตัวเลขในรายงานนี้อาจเป็น 0 ทั้งหมด, ร้าน ${store.store_name ?? params.storeId} ` +
        `มี ad account ที่มีสิทธิ์ GMV Max คือ ${exclusive.advertiser_name ?? "?"} ` +
        `(${exclusive.advertiser_id}) แต่รายงานนี้สั่งด้วย advertiser ${params.advertiserId}, ` +
        `ให้ authorize บัญชี ${exclusive.advertiser_id} ผ่าน gmv-max-telegram-bot แล้วสั่งใหม่`
    );
    logger.warn("Reporting advertiser is not the store's exclusive GMV Max advertiser", {
      storeId: params.storeId,
      requestedAdvertiserId: params.advertiserId,
      exclusiveAdvertiserId: exclusive.advertiser_id,
    });
  } else if (store.is_gmv_max_available !== true) {
    warnings.push(
      `ร้าน ${store.store_name ?? params.storeId} มี is_gmv_max_available=false, ` +
        `ข้อมูลอาจว่างหรือไม่ครบ`
    );
  }
  if (store.store_status && store.store_status !== "ACTIVE") {
    warnings.push(`ร้าน ${store.store_name ?? params.storeId} มีสถานะ ${store.store_status}`);
  }

  return {
    context: {
      advertiserId: params.advertiserId,
      storeId: params.storeId,
      storeAuthorizedBcId: bcId,
    },
    storeName: store.store_name ?? params.storeId,
    warnings,
  };
}
