# apps/engine

**Purpose:** a local server that gives the agents their work and runs what they propose through
control, on mock rails (default) or on the real Metal testnet (`RAILS_MODE=sandbox`, below). Lane A builds the agents against it; lane D's dashboard and the analyzer
read its event log. Start it with `pnpm engine` (port `ENGINE_PORT`, default 4000).

**The loop:**

1. `GET /world`: agent ids, warrant ids, the payees each agent may pay, stored orders.
2. `GET /tasks?role=sourcing|support|treasury&limit=10`: the next tasks for that agent. Taking a
   task removes it from the queue. Each task has `content`, the raw offer/ticket/invoice text. It
   is untrusted and may be an attack.
3. The agent decides and calls its one tool, `propose_payment`. The runner sends that as a
   `PaymentProposal` to `POST /proposals` (copy the task's `sourceRef`; for refunds set
   `refundOfOrderId`, never an address).
4. The answer is control's decision: `execute` (paid, mock), `needs_owner_approval`, or
   `blocked` with `blockedBy` (`rules`, `purpose`, `owner`, `rail`, `malformed`).
5. `GET /events?since=<seq>`: every proposal, approval and payment in order, for the analyzer and
   the dashboard. Also the store's side: `pass_checked` (each warrant pass our store checks,
   sandbox) and `dispute_decided` (each dispute answered, `POST /disputes` or a scene).

**Owner side:** `GET /approvals` lists what waits; `POST /approvals/<proposalId>` with
`{"decision":"approved","shownHash":"<the shownHash you displayed>"}` (or `"denied"`) answers it.
The hash is required (ADR-007): an answer is bound to exactly what the owner saw, so a missing hash
is a 400 and a stale or different one is refused.

**Owner's key:** `pnpm engine` makes a fresh owner key each start (or uses `OWNER_TOKEN`) and
prints the owner link, `<dashboard>/#/m?owner=<key>`. Answering approvals and `POST /kill` need
`Authorization: Bearer <key>` (401 otherwise); every read stays open. The dashboard moves the key
from the link into the tab's session storage. `createEngine()` without `ownerToken` (tests) is open.

**Treasury's spend review (#26, ADR-020):** `POST /treasury/review` queues a `spend_review` task
built from the signed USDZ warrants, the ledger's spend and, when it is above sourcing's
per-payment limit, the upstream price (`treasury.ts`). Treasury answers with `propose_limits`,
which arrives on `POST /budget-changes`. It moves no money.

**Owner controls:** `POST /kill` is the emergency stop (everything refused at once, approvals
dropped, mock mandates revoked; the answer says how long it took). `POST /budget-changes` takes
treasury's `BudgetChangeProposal`; it always waits in `/approvals`, and on approval the mandate is
replaced and the next warrant version signed.

**Mock Metal chain:** the Metal rail is the real `MetalAdapter` on an in-memory chain that enforces
each mandate. `GET /chain` shows mandates, spend and on-chain refusals; `POST /upstream/price
{"cents":4}` raises the provider's price; `POST /limits-only/pay` pays around Warrant (benchmark
"limits only" mode). `pnpm scene` plays the Kit 11 price rise and limit change start to finish.

**Airwallex (lane B base):** `pnpm scene:earnings` plays DEMO beat 6 on the mock chain and the
Airwallex mock: the store's earnings move off Metal (`mandate pull`), land as an Airwallex deposit
referenced by the tx hash, and treasury pays the EUR 50 licence fee through control (the adapter in
`packages/rails/src/airwallex` converts USD to EUR when the wallet is short, then sends a LOCAL
transfer; PAID is confirmed on `controller.reconcile()`). `mockAirwallexWorld()` builds that world;
`pnpm engine` still uses the always-pays Airwallex stand-in.
**Card (Kit 2, ADR-018):** `pnpm scene:card` gives treasury a second warrant, `wrt_treasury_card`
(payee "Design tool seat", USD 12.00 a month, MCC 5734), paid by `AirwallexCards` on a virtual Visa
whose own limits mirror the warrant. Mock Airwallex by default; `--sandbox` (or `AIRWALLEX_ENV` /
`RAILS_MODE=sandbox`) uses the keys in `.env` and `AIRWALLEX_CARD_ID` if set. A world built with a
card rail (`makeWorld(now, { card })`) freezes its cards on `POST /kill` (`killHooks`).
**Disputes (ADR-012):** `GET /orders` lists the store's signed orders with their passes.
`POST /disputes {"orderIds":["ord_1","ord_2"],"claim":"wrong_data"}` (claims: `wrong_data`,
`not_delivered`, `not_authorized`, `other`) answers with one decision per order and the evidence
behind it: the settlement on chain, the signed order, the customer's pass, the data batch. It
moves no money; support then refunds through `POST /proposals` (`refundOfOrderId`, with the
answer's `ticketRef` as `sourceRef`), paid by `mandate pull`. The store keeps every dispute on file
(those opened here and every dispute task `GET /tasks` hands out, whose ticket is the task's
`sourceRef`); a refund may only cover the orders of the dispute its `sourceRef` names (#84). `pnpm scene:dispute` plays the dispute beat start to finish (mock chain).

**Scenarios:** `POST /scenario {"name":"normal|price_rise|dispute|attacks|all"}` replaces the queue
(`all` loads at startup). `GET /labels` says which tasks are attacks and what should happen. It is
for the analyzer only: never show labels to an agent.

**`pnpm live` (`--agents`) and the rails choice:** `pnpm live` runs the three agents inside the
engine (`startAgents`, the hosted demo's driver) with `brainFromEnv()`: the model when
`ANTHROPIC_API_KEY` is set (capped by `AGENT_MAX_CALLS`), else the script. It starts with an empty
queue, so nothing is paid until a scenario is loaded. `pnpm engine` and `pnpm live` pick rails with
`engineRailsMode()`: `RAILS_MODE=mock|sandbox` wins; unset or `auto` means testnet when METAL_HOME,
METAL_RPC_URL and `METAL_HOME/warrant-public.env` exist, else mock. The scenes keep `railsMode()`
(testnet only when `RAILS_MODE=sandbox`). The driver passes treasury's `propose_limits` to
`POST /budget-changes`, so a spend review (the dashboard's "Ask treasury to review spending") is
answered.

**Purpose check:** `pnpm engine` uses lane A's `purposeFromEnv()` (model with `ANTHROPIC_API_KEY`, else
the deterministic check). `createEngine()` without `purpose` keeps `placeholderPurpose` (tests).
Pass your own `PurposeChecker` to `createEngine({ purpose })`.

**Live mode (`RAILS_MODE=sandbox`, `live.ts`):** the same engine and scenes on Metal testnet: the
real `metal-agent` 0.3.3 pays, the upstream provider is a real x402 seller on `UPSTREAM_PORT`, our
store runs on `STORE_PORT`, and an approved budget change runs `mandate replace` on chain.
Warrants are signed from `mandate status` at startup. The current credential per agent is kept in
`WARRANT_DATA_DIR/owner-state.json` (default `METAL_HOME/warrant-live`, outside the repo).
Airwallex stays on the in-memory rail. `pnpm scene`, `pnpm reset:live`, `pnpm setup:testnet`:
see docs/TESTNET.md "Running live". `config.ts` reads the env (`.env`, `WARRANT_ENV_FILE`,
`METAL_HOME/warrant-public.env`).

**Must never:** in mock mode, use a real key, account, credential or network (everything is in
memory and made fresh at startup). In live mode: print, log or return a key, a credential's
contents or the RPC URL; give an agent anything from METAL_HOME; touch mainnet or production.

**Hosted demo (`hosted.ts`, #89):** the built dashboard plus one mock engine per signed-in
visitor, behind one access code (`DEMO_PASSWORD`, `DEMO_COOKIE_SECRET`; refuses to start without
them or with `RAILS_MODE=sandbox`). Bundled by `build-hosted.mjs` and run with plain `node` on
Render (`render.yaml`, docs/RUNBOOK.md "Hosted demo"). Never give it a key.
