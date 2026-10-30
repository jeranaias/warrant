/**
 * Control layer: the ONLY path by which money leaves.
 *
 *   PaymentProposal
 *     -> rules/       deterministic checks in code           -> RulesResult
 *     -> purpose/     separate model, sees Warrant + PaymentSummary only -> PurposeVerdict
 *     -> approvals/   owner approval bound to shownHash when required
 *     -> ledger/      reserve -> rail.execute -> confirm | release | unconfirmed
 *   killswitch/       revoke all warrants, freeze cards, release open reservations
 */
export * from "./business.js";
export * from "./crypto.js";
export * from "./rules/index.js";
export * from "./ledger/index.js";
// TODO(control): export submitProposal(proposal): Promise<ControlDecision>
