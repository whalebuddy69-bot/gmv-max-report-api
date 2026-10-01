import { IsNull } from "typeorm";
import { AppDataSource } from "../db/dataSource";
import { OAuthToken } from "../entities/OAuthToken";
import { decryptSecret } from "../utils/crypto";
import { TokenExpiredError } from "../utils/errors";

/** Newest non-revoked token for the advertiser, decrypted. */
export async function getAccessTokenForAdvertiser(advertiserId: string): Promise<string> {
  const row = await AppDataSource.getRepository(OAuthToken).findOne({
    where: { advertiserId, revokedAt: IsNull() },
    order: { authorizedAt: "DESC" },
  });

  if (!row) {
    throw new TokenExpiredError(advertiserId, "no active token row in oauth_tokens");
  }

  try {
    return decryptSecret(row.accessTokenEncrypted);
  } catch {
    // usually a TOKEN_ENCRYPTION_KEY mismatch
    throw new Error(
      `ถอดรหัส access_token ของ advertiser ${advertiserId} ไม่ได้, ` +
        `ตรวจสอบว่า TOKEN_ENCRYPTION_KEY ตรงกับของ gmv-max-telegram-bot เป๊ะๆ`
    );
  }
}
