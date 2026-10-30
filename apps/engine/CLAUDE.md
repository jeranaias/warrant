# apps/engine

**Purpose:** a local server that gives the agents their work and runs what they propose through
control, on mock rails. Lane A builds the agents against it; lane D's dashboard and the analyzer
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
   the dashboard.

**Owner side:** `GET /approvals` lists what waits; `POST /approvals/<proposalId>` with
`{"decision":"approved"}` or `{"decision":"denied"}` answers it.

**Scenarios:** `POST /scenario {"name":"normal|price_rise|dispute|attacks|all"}` replaces the queue
(`all` loads at startup). `GET /labels` says which tasks are attacks and what should happen. It is
for the analyzer only: never show labels to an agent.

**Purpose check:** a placeholder (`placeholderPurpose` in `world.ts`) until lane A's model lands.
Pass your own `PurposeChecker` to `createEngine({ purpose })`.

**Must never:** use a real key, account, credential or network. Everything here is in memory and
made fresh at startup.
