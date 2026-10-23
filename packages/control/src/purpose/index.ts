// TODO(control): buildPaymentSummary(proposal, warrant, ledgerView): PaymentSummary
// TODO(control): checkPurpose(warrant, summary): Promise<PurposeVerdict>
// The model sees ONLY the signed warrant + PaymentSummary. Never proposal.justification,
// never sourceRef content, never raw invoice/offer text. Parse output with PurposeVerdict.
export {};
