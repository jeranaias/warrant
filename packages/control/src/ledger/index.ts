// TODO(control): append-only, hash-chained ledger of LedgerEntry.
// reserve(proposal) -> confirm(reservationId, railRef) | release(reservationId) | markUnconfirmed(...)
// Timeouts become `unconfirmed`; resolve via rail.getStatus(idempotencyKey) before any retry.
export {};
