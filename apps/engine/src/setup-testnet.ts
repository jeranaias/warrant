import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_BUDGETS } from "@warrant/control";
import { centsToUsdz, execCliRunner, parseKv } from "@warrant/rails";
import type { CliResult } from "@warrant/rails";
import { liveConfigFromEnv, loadEnv } from "./config.js";

/**
 * `pnpm setup:testnet`: the owner's Metal testnet setup (Kit 11 checklist item 1). Creates the
 * four accounts (business, customer, upstream, earnings), funds the two that pay, and creates and
 * binds the four mandates with the ADR-009 numbers. Keys stay in METAL_HOME. Prints, and writes
 * to METAL_HOME/warrant-public.env, only public facts (addresses, mandate ids).
 *
 * Re-running reuses what exists: an owner key file is reused, a credential file is bound again
 * (a no-op when bound). After a kill switch, move the revoked credential files out first (see
 * docs/TESTNET.md "Running live"). SKIP_FUND=1 skips the faucet (rate limited; the payers keep
 * their USDZ). SKIP_CUSTOMER=1 leaves the customer's mandate alone.
 */
loadEnv();
// Addresses come from this run, so only METAL_HOME and METAL_RPC_URL need to be set.
process.env["METAL_STORE_ADDRESS"] ??= "set by this run";
process.env["METAL_UPSTREAM_ADDRESS"] ??= "set by this run";
const cfg = liveConfigFromEnv();
const run = execCliRunner(cfg.bin, cfg.cliEnv);
const days = Number(process.env["METAL_MANDATE_DAYS"] ?? 21);
const expiresIn = days * 86_400;
const net = ["--network", "testnet"];
const chain = [...net, "--rpc-url", cfg.rpcUrl];
const f = (name: string) => join(cfg.home, name);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ADDRESS = /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/;

async function cli(args: string[]): Promise<CliResult> {
  const r = await run(args, 180_000);
  // Windows: metal-agent 0.3.3 can crash on exit after succeeding; judge by its output.
  if (r.code !== 0 && !r.stdout.trim()) {
    throw new Error(`${args.slice(0, 3).join(" ")} failed: ${firstLine(r.stderr)}`);
  }
  return r;
}

function firstLine(s: string): string {
  return (s.split(/\r?\n/).find((l) => l.trim()) ?? "").replace(/\S*[/\\]\S*/g, "<path>");
}

async function account(role: string): Promise<string> {
  const file = `${role}-owner.json`;
  const args = existsSync(f(file))
    ? ["account", "create", "--key", f(file), ...chain]
    : ["account", "create", "--out", f(file), ...chain];
  const r = await cli(args);
  const addr = parseKv(r.stdout).get("account") ?? ADDRESS.exec(r.stdout)?.[0];
  if (!addr || !ADDRESS.test(addr)) throw new Error(`no address printed for ${role}`);
  console.log(`${role}: ${addr}`);
  return addr;
}

/** Faucet: about one grant a minute and a few a day per IP; 429s are common. */
async function fund(address: string): Promise<void> {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const r = await run(["fund", address, ...net], 120_000);
    if (r.code === 0 || /funded|transaction/i.test(r.stdout)) return;
    console.log(`fund ${address.slice(0, 8)}: ${firstLine(r.stderr)} (try ${attempt}/4)`);
    await sleep(90_000);
  }
  throw new Error(`could not fund ${address}; use the console Faucet page, then SKIP_FUND=1`);
}

async function mandate(o: {
  out: string;
  principal: string;
  ownerKey: string;
  capCents: number;
  budgetCents: number;
  payees: string[];
  description: string;
}): Promise<string> {
  if (!existsSync(f(o.out))) {
    await cli([
      "mandate",
      "credential",
      "create",
      "--principal",
      o.principal,
      "--cap",
      centsToUsdz(o.capCents),
      "--budget",
      centsToUsdz(o.budgetCents),
      "--expires-in",
      String(expiresIn),
      "--key",
      f(o.ownerKey),
      "--out",
      f(o.out),
      "--description",
      o.description,
      ...o.payees.flatMap((p) => ["--payee", p]),
      ...net,
    ]);
  }
  const b = await cli([
    "mandate",
    "bind",
    "--credential",
    f(o.out),
    "--key",
    f(o.ownerKey),
    ...chain,
  ]);
  const s = await cli(["mandate", "status", "--credential", f(o.out), ...chain]);
  // bind prints "bound <id>"; status prints "mandate <id>"
  const kv = parseKv(`${b.stdout}\n${s.stdout}`);
  const id = kv.get("bound") ?? kv.get("mandate");
  if (!id) throw new Error(`no mandate id for ${o.out}`);
  console.log(`${o.out}: ${id}`);
  return id;
}

const acct = {
  business: await account("business"),
  customer: await account("customer"),
  upstream: await account("upstream"),
  earnings: await account("earnings"),
};
// Only the two payers need USDZ.
if (process.env["SKIP_FUND"] !== "1") {
  await fund(acct.business);
  await sleep(62_000);
  await fund(acct.customer);
}

const B = AGENT_BUDGETS;
const owner = "business-owner.json";
const ids = {
  sourcing: await mandate({
    out: cfg.credentials.sourcing,
    principal: acct.business,
    ownerKey: owner,
    capCents: B.sourcing.perPaymentCap.cents,
    budgetCents: B.sourcing.budget.cents,
    payees: [acct.upstream],
    description: "Warrant sourcing: upstream market data",
  }),
  support: await mandate({
    out: cfg.credentials.support,
    principal: acct.business,
    ownerKey: owner,
    capCents: B.support.perPaymentCap.cents,
    budgetCents: B.support.budget.cents,
    payees: [],
    description: "Warrant support: customer refunds",
  }),
  treasury: await mandate({
    out: "treasury.json",
    principal: acct.business,
    ownerKey: owner,
    capCents: B.treasury.perPaymentCap.cents,
    budgetCents: B.treasury.budget.cents,
    payees: [acct.earnings],
    description: "Warrant treasury: earnings payouts",
  }),
  // The simulated customer is another business: our kill switch never revokes its mandate.
  customer:
    process.env["SKIP_CUSTOMER"] === "1"
      ? undefined
      : await mandate({
          out: "customer-agent.json",
          principal: acct.customer,
          ownerKey: "customer-owner.json",
          capCents: 5,
          budgetCents: 200,
          payees: [acct.business],
          description: "Customer agent: buys our queries",
        }),
};
const lines = [
  `METAL_STORE_ADDRESS=${acct.business}`,
  `METAL_CUSTOMER_ADDRESS=${acct.customer}`,
  `METAL_UPSTREAM_ADDRESS=${acct.upstream}`,
  `METAL_EARNINGS_ADDRESS=${acct.earnings}`,
  `METAL_SOURCING_MANDATE=${ids.sourcing}`,
  `METAL_SUPPORT_MANDATE=${ids.support}`,
  `METAL_TREASURY_MANDATE=${ids.treasury}`,
  ...(ids.customer ? [`METAL_CUSTOMER_MANDATE=${ids.customer}`] : []),
];
writeFileSync(f("warrant-public.env"), lines.join("\n") + "\n");
console.log(`\nPublic values (saved to METAL_HOME/warrant-public.env):\n${lines.join("\n")}`);
