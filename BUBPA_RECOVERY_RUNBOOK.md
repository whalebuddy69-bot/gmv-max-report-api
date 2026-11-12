# Bubpa historical UNKNOWN recovery

This is an audited, different-campaign quarantine, not proof that an old write applied or failed. It does not retry TikTok or restore a previous budget. The old operation remains `OUTCOME_UNKNOWN`, its session remains STOPPED, and its reserved notification is not reported as success.

## Deployment order and rollback

1. Deploy the compatible Render control plane first (commit `b6aefcf` or a compatible descendant). Its dedicated gate is `CREATOR_WEB_BUBPA_SHOP189_RECOVERY_ENABLED=true`.
2. Deploy the compatible API (commit `3a58ffd` or a compatible descendant). Its gate is `CREATOR_BUDGET_BUBPA_RECOVERY_ENABLED=true`.
3. Verify both health checks, old deployment removal, audit table and nullable annotation columns, and the two exact named unique indexes. Catalog index keys must be selected as `text[]`: node-postgres does not decode `name[]` into an array.

After quarantine, **do not roll back either service to a pre-recovery binary**. Keep compatible schema and campaign-scope checks. Never delete audit rows, recreate an old unconditional fence, clear UNKNOWN, release a consumed attempt, or convert an uncertain operation to `NOT_SENT`/`APPLIED_VERIFIED` without provider proof.

## Recovery

- Recheck the exact original owner's active user/session and both operator/viewer allowlists. No forged JWT or direct SQL reset.
- Verify old campaign DISABLE, the unique eligible replacement ENABLE, exact Creator/advertiser/BC identity, THB/Bangkok, valid schedule, stable settings and fresh evidence. A future start is valid; it is not permission to send early.
- Use one stable recovery UUID. The service stages the audit, obtains the scoped Render quarantine receipt, rereads provider evidence, then finalizes both API annotations atomically. Retry a partial recovery with that same UUID and exact request; inspect durable state first after a lost response.
- A changed replacement before staging requires fresh verification. Once staged, never silently substitute its campaign ID.
- This release allows **one reviewed Bubpa succession** and only its audited replacement campaign. A later different campaign or another UNKNOWN needs separate review, not a generic unlock.
- Recovery itself never arms Auto. Explicitly arm a new persistent session using the latest verified budget, cap revision and settings, plus the operator's native-Auto-off and no-concurrent-change attestations.

## Verification

Verify persistent ACTIVE state, exact replacement ID, `autoDetectLive`, `keepAutoAcrossRooms`, ceiling, ready LINE routing, and at least two natural minute checks. Before its schedule starts, budget must remain unchanged and the check failure counter must stay zero. A LIVE ending/restarting on the same campaign keeps the operator's enabled state and rebinds only a verified room.

Budget logic remains 80% → +20%, rounded up to whole baht and subject to both caps. Bubpa sends one provider POST only; successful acknowledgements allow at most three GET-only readback pairs within 20 seconds. Different settings or unverified outcomes remain fenced. No success LINE may be emitted until the new amount has been verified. Preserve safe failure codes; never log tokens or raw provider payloads.

Validation for this release: API 987 tests, Render 375 tests, API build/typecheck and both diff checks passed. Deployment and runtime checks are still required; test results alone do not prove that a live budget was increased.
