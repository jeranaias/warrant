import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { SignedOrderRecord } from "@warrant/contracts";

/**
 * Append-only store of signed orders (Kit 11: "Store each signed order with its transaction hash
 * and what you delivered. Nothing stores them for you."). One JSON line per sale. Never edited.
 */
export class OrderStore {
  private readonly byId = new Map<string, SignedOrderRecord>();
  private readonly byTx = new Map<string, string>();

  constructor(private readonly file?: string) {
    if (file && existsSync(file)) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (line.trim()) this.index(SignedOrderRecord.parse(JSON.parse(line)));
      }
    }
  }

  /** Adds a sale. A second record for the same tx hash or order id is refused. */
  add(record: SignedOrderRecord): SignedOrderRecord {
    const r = SignedOrderRecord.parse(record);
    if (this.byId.has(r.orderId)) throw new Error("order id already stored");
    if (this.byTx.has(r.txHash.toLowerCase())) throw new Error("transaction already stored");
    if (this.file) appendFileSync(this.file, JSON.stringify(r) + "\n");
    this.index(r);
    return r;
  }

  get(orderId: string): SignedOrderRecord | undefined {
    return this.byId.get(orderId);
  }

  byTransaction(txHash: string): SignedOrderRecord | undefined {
    const id = this.byTx.get(txHash.toLowerCase());
    return id === undefined ? undefined : this.byId.get(id);
  }

  byPayer(payer: string): SignedOrderRecord[] {
    const p = payer.toLowerCase();
    return this.list().filter((o) => o.payer.toLowerCase() === p);
  }

  list(): SignedOrderRecord[] {
    return [...this.byId.values()];
  }

  /** Read-only view for control's refund rule (orders by id). */
  asMap(): ReadonlyMap<string, SignedOrderRecord> {
    return this.byId;
  }

  private index(r: SignedOrderRecord): void {
    this.byId.set(r.orderId, r);
    this.byTx.set(r.txHash.toLowerCase(), r.orderId);
  }
}
