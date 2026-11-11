import { describe, expect, it } from "vitest";
import { verifiedCreatorAutoAlertIdentity } from "./creatorAutoAdvertiserName.service";

const accounts = [
  ["punpan_020", "7666005333864644624", "punpan_020_Owner", "punpanshop888"],
  ["srihiw", "7603349337834192912", "ใหม่ขายถูก", "srihiw"],
  ["nnshop5719", "7669107155332808725", "nnshop5719 Livestream", "nnshop5719"],
  ["ashopbytheta", "7646716403715571730", "ashopbytheta", "ashopbytheta"],
  ["myushop4", "7658481851635613703", "myushop4 Livestream", "myushop4"],
  ["bubpa_shop189", "7632368323640115207", "บริษัท บุบผา ช๊อป 189 จำกัด (Live GMV Max)", "bubpa_shop189"],
  ["koolkool888", "7469805960727379976", "บริษัท จุฑากูล จำกัด0210", "koolkool888"],
  ["boomkan", "7579621103212150801", "บริษัท เทย กะ ทะ เอ็นเตอร์เทนเมนท์ จำกัด", "boomkan"],
] as const;

describe("Creator Auto alert identity", () => {
  it.each(accounts)("returns the verified display pair only for %s / %s", (clientId, advertiserId, advertiserName, tiktokUsername) => {
    expect(verifiedCreatorAutoAlertIdentity(clientId, advertiserId)).toEqual({ advertiserName, tiktokUsername });
    expect(advertiserName).toMatch(/^[^\p{Cc}\p{Cf}]{1,120}$/u);
    expect(tiktokUsername).toMatch(/^[A-Za-z0-9._]{1,24}$/);
    for (const [otherClientId, otherAdvertiserId] of accounts) {
      if (otherClientId !== clientId) {
        expect(verifiedCreatorAutoAlertIdentity(clientId, otherAdvertiserId)).toBeNull();
        expect(verifiedCreatorAutoAlertIdentity(otherClientId, advertiserId)).toBeNull();
      }
    }
  });

  it("rejects unknown, aliased and modified scopes; callers cannot mutate the snapshot", () => {
    const [clientId, advertiserId, advertiserName, tiktokUsername] = accounts[0];
    expect(verifiedCreatorAutoAlertIdentity("unknown", advertiserId)).toBeNull();
    expect(verifiedCreatorAutoAlertIdentity(tiktokUsername, advertiserId)).toBeNull();
    expect(verifiedCreatorAutoAlertIdentity(clientId.toUpperCase(), advertiserId)).toBeNull();
    expect(verifiedCreatorAutoAlertIdentity(clientId, `${advertiserId} `)).toBeNull();
    const value = verifiedCreatorAutoAlertIdentity(clientId, advertiserId)!;
    value.advertiserName = "not persisted";
    expect(verifiedCreatorAutoAlertIdentity(clientId, advertiserId)).toEqual({ advertiserName, tiktokUsername });
  });
});
