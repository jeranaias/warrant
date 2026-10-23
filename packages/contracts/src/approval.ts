import { z } from "zod";
import { Id, Timestamp } from "./common.js";

const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * Owner approval binds to a hash of EXACTLY what was displayed.
 * If any shown field changes, the hash changes and the approval is void: ask again.
 */
export const OwnerApproval = z
  .object({
    approvalId: Id,
    proposalId: Id,
    /** sha256 of the canonical JSON rendered on screen. */
    shownHash: Sha256Hex,
    decision: z.enum(["approved", "denied"]),
    ownerId: Id,
    decidedAt: Timestamp,
  })
  .strict();
export type OwnerApproval = z.infer<typeof OwnerApproval>;

/** Owner kill switch: revokes every warrant and freezes every card in one event. */
export const KillSwitchEvent = z
  .object({
    eventId: Id,
    ownerId: Id,
    reason: z.string().max(500),
    revokedWarrantIds: z.array(Id),
    frozenCardIds: z.array(Id),
    releasedReservationIds: z.array(Id),
    at: Timestamp,
  })
  .strict();
export type KillSwitchEvent = z.infer<typeof KillSwitchEvent>;
