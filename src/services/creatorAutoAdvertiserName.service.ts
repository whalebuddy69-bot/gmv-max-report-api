type CreatorAutoAlertIdentity = { advertiserName: string; tiktokUsername: string };

// Display-only identities independently verified on 2026-11-10 via TikTok's
// exact OAuth advertiser grant and the matching Creator identity read. Pin the
// literal advertiser IDs: a later binding change must not inherit an old label.
// This snapshot is also available when TikTok is the reason for the alert.
const verified = new Map<string, readonly [advertiserId: string, advertiserName: string, tiktokUsername: string]>([
  ["punpan_020", ["7666005333864644624", "punpan_020_Owner", "punpanshop888"]],
  ["srihiw", ["7603349337834192912", "ใหม่ขายถูก", "srihiw"]],
  ["nnshop5719", ["7669107155332808725", "nnshop5719 Livestream", "nnshop5719"]],
  ["ashopbytheta", ["7646716403715571730", "ashopbytheta", "ashopbytheta"]],
  ["myushop4", ["7658481851635613703", "myushop4 Livestream", "myushop4"]],
  ["bubpa_shop189", ["7632368323640115207", "บริษัท บุบผา ช๊อป 189 จำกัด (Live GMV Max)", "bubpa_shop189"]],
  ["koolkool888", ["7469805960727379976", "บริษัท จุฑากูล จำกัด0210", "koolkool888"]],
]);

export function verifiedCreatorAutoAlertIdentity(clientId: string, advertiserId: string): CreatorAutoAlertIdentity | null {
  const identity = verified.get(clientId);
  if (!identity || identity[0] !== advertiserId) return null;
  return { advertiserName: identity[1], tiktokUsername: identity[2] };
}
