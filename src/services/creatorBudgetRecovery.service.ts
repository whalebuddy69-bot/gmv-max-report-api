import { WebBudgetError } from "./creatorWebBudget.service";
import { validCreatorBudgetRecoveryEvidence, validCreatorBudgetRecoveryReceipt, validCreatorBudgetRecoveryRequest,
  type CreatorBudgetRecoveryEvidence, type CreatorBudgetRecoveryLeaseRequest, type CreatorBudgetRecoveryReceipt,
  type CreatorBudgetRecoveryRequest, type createCreatorBudgetRecoveryStore } from "./creatorBudgetRecovery.store";

export function createCreatorBudgetRecoveryService({ store, readEvidence, recheckOperator, releaseOldLease, now = () => new Date() }: {
  store: Pick<ReturnType<typeof createCreatorBudgetRecoveryStore>, "get" | "stage" | "finalize">;
  readEvidence: (input: CreatorBudgetRecoveryRequest) => Promise<CreatorBudgetRecoveryEvidence>;
  recheckOperator: (operatorUserId: number) => Promise<boolean>;
  releaseOldLease: (input: CreatorBudgetRecoveryLeaseRequest) => Promise<CreatorBudgetRecoveryReceipt>;
  now?: () => Date;
}) {
  return {
    async recover(operatorUserId: number, input: CreatorBudgetRecoveryRequest) {
      if (!Number.isSafeInteger(operatorUserId) || operatorUserId <= 0 || !validCreatorBudgetRecoveryRequest(input))
        throw new WebBudgetError("BUDGET_RECOVERY_INPUT_INVALID", 400, "ต้องยืนยันรายการเก่าและแคมเปญใหม่ให้ตรงกัน");
      if (!await recheckOperator(operatorUserId)) throw new WebBudgetError("BUDGET_OPERATOR_DENIED", 403, "ยังยืนยันสิทธิ์กู้คืนไม่ได้");
      const existing = await store.get(input.recoveryId);
      if (existing && (existing.operatorUserId !== operatorUserId || existing.oldOperationId !== input.oldOperationId ||
        existing.oldCampaignId !== input.oldCampaignId || existing.newCampaignId !== input.newCampaignId))
        throw new WebBudgetError("BUDGET_RECOVERY_ID_CONFLICT", 409, "รหัสกู้คืนถูกใช้กับรายการอื่นแล้ว");
      // Completed retries return the immutable receipt, without touching a later
      // lease, checking an old LIVE, changing budgets or repeating notifications.
      if (existing?.status === "QUARANTINED") return existing;
      const before = await readEvidence(input);
      if (!validCreatorBudgetRecoveryEvidence(before, input, now())) throw new WebBudgetError("BUDGET_RECOVERY_EVIDENCE_UNVERIFIED", 409, "ยังยืนยันแคมเปญเก่าปิดและแคมเปญใหม่ที่ตรงกันไม่ได้");
      const staged = await store.stage(operatorUserId, input, before);
      if (!await recheckOperator(operatorUserId)) throw new WebBudgetError("BUDGET_OPERATOR_DENIED", 403, "สิทธิ์เปลี่ยนก่อนกู้คืน");
      const receipt = await releaseOldLease({ recoveryId: staged.recoveryId, operatorUserId, oldOperationId: staged.oldOperationId,
        oldCampaignId: staged.oldCampaignId, newCampaignId: staged.newCampaignId, revision: staged.revision, acknowledgedUnknown: true });
      if (!validCreatorBudgetRecoveryReceipt(receipt, staged) || receipt.locked) throw new WebBudgetError("BUDGET_RECOVERY_RECEIPT_UNVERIFIED", 409, "ยังยืนยันการแยกรายการเก่าจากระบบควบคุมไม่ได้");
      const after = await readEvidence(input);
      if (!validCreatorBudgetRecoveryEvidence(after, input, now()) || after.identityFingerprint !== before.identityFingerprint)
        throw new WebBudgetError("BUDGET_RECOVERY_EVIDENCE_UNVERIFIED", 409, "ข้อมูลแคมเปญเปลี่ยนระหว่างตรวจซ้ำ ยังไม่ปลดรายการเก่า");
      if (!await recheckOperator(operatorUserId)) throw new WebBudgetError("BUDGET_OPERATOR_DENIED", 403, "สิทธิ์เปลี่ยนก่อนยืนยันกู้คืน");
      // This authorizes only the different campaign. Historical UNKNOWN remains
      // UNKNOWN; Auto must be armed separately against fresh current conditions.
      return store.finalize(staged.recoveryId, receipt, after);
    },
  };
}
