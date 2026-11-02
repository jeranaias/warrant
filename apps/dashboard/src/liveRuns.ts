/**
 * The same flows, run on the real Airwallex sandbox and Metal testnet. Copied from docs/TESTNET.md
 * (the source of truth); update both together. Hashes link to the Metal testnet explorer.
 */

export const METAL_EXPLORER = "https://testnet.metalntwx.com/tx/";

export interface LiveStep {
  what: string;
  result: string;
  /** A Metal testnet transaction, linked to the explorer. */
  tx?: string;
  /** An Airwallex sandbox object id (not public, shown as data). */
  ref?: string;
}

export interface LiveRun {
  title: string;
  where: string;
  date: string;
  steps: LiveStep[];
}

export const LIVE_RUNS: LiveRun[] = [
  {
    title: "Dispute, decided from the store's records",
    where: "Metal testnet",
    date: "2026-11-02",
    steps: [
      {
        what: "Customer's agent buys fx-eurusd with a warrant pass",
        result: "paid, order ord_aa559b97",
        tx: "0x32a27368497132405e32be077a8c434513452a853a1c5422955caddb954ca595",
      },
      {
        what: "Customer's agent buys btc-usd with a warrant pass",
        result: "paid, order ord_42e3ae23",
        tx: "0x6f6584449fcb9be4ed6864cc1c3b42fc77c5d20a2571b330e21c89fbe7b9940b",
      },
      {
        what: "Store checks the pass before serving",
        result: "owner key f1d35b487fd9cf20, mandate 0x6908b0a2…, cap 0.05",
      },
      {
        what: "Dispute: data was wrong, both orders",
        result: "both verified on chain; ord_aa559b97 refund 5c, ord_42e3ae23 kept",
      },
      {
        what: "Support refunds the stale order (mandate pull)",
        result: "refunded",
        tx: "0x2314f9bc7aebbafaa150bf413480794df92d40e73431ada76cd3354514fae8f0",
      },
      { what: "Same refund again", result: "refused by the rules (refund_matches_order)" },
      { what: '"My agent never agreed"', result: "rejected: 11 of 11 checks hold" },
    ],
  },
  {
    title: "Mandate enforces the cap on chain",
    where: "Metal testnet",
    date: "2026-10-31",
    steps: [
      {
        what: "Buy at 2 cents",
        result: "paid",
        tx: "0x9c5fe578fd92d68e3b55362b04d73d9bd0daac22b5a19df8b4c7b74ef86ed2a8",
      },
      { what: "Price rises to 4 cents", result: "refused by the rules (per_payment_cap)" },
      { what: "Limits only, pay at 4 cents", result: "refused on chain (mandate_cap_exceeded)" },
      {
        what: "Owner approves a 4-cent cap",
        result: "mandate replaced (v2)",
        tx: "0x15353bfe8f781331680bd1d45d1bc882cda08c6042b73148d261034430dfe097",
      },
      {
        what: "Buy at 4 cents",
        result: "paid",
        tx: "0x3979bf6f412a4b11a8b1e172514c8b2f1d155812ecaf4f60f0f22ff0027c0a3a",
      },
    ],
  },
  {
    title: "EUR licence fee",
    where: "Airwallex sandbox",
    date: "2026-11-02",
    steps: [
      { what: "Earnings deposited into the USD Global Account", result: "settled" },
      { what: "USD to EUR conversion", result: "created" },
      {
        what: "EUR 50.00 licence fee by SWIFT",
        result: "PAID; control's ledger confirmed it",
        ref: "5ea7d69d-e8f4-4919-aa0c-19a9af9758d1",
      },
    ],
  },
  {
    title: "Virtual Visa card for the design tool seat",
    where: "Airwallex sandbox",
    date: "2026-11-02",
    steps: [
      { what: "USD 12.00 seat", result: "approved by the rules, authorised by the card" },
      { what: "USD 40.00 purchase", result: "blocked by the rules (per_payment_cap)" },
      { what: "Same purchase at the card", result: "declined by Airwallex (LIMIT_EXCEEDED)" },
      { what: "STOP", result: "card frozen in 627 ms" },
      { what: "Purchase after STOP", result: "declined (CARD_INACTIVE)" },
    ],
  },
];
