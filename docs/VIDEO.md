# Video script: Draft, for Eva

Draft for issue #91. Eva owns the final cut (#33). Target: under 4 minutes (the limit is 5).

Rules for the recording (from `docs/DEMO.md`): everything shown is sandbox or testnet and says so
in the data, not in an overlay. Never show a key, a credential file, the owner link, a card
number or `.env`. Transaction hashes appear as data: terminal output, the **Live runs** panel or
the testnet explorer.

Most beats are recorded on the hosted demo (https://warrant-demo-bt31.onrender.com, simulated
money): the **Decision Desk** is the main screen, and **Flow** in the header switches to the gate
view. Press **Reset** before each take. A full run takes about 30 seconds after **Run a
scenario**, so there is room to slow down in the edit.

## Beat sheet

| #   | Time      | Beat                               | Runs on                             |
| --- | --------- | ---------------------------------- | ----------------------------------- |
| 1   | 0:00-0:15 | Cold open on Flow                  | Hosted demo                         |
| 2   | 0:15-0:50 | Run a scenario: the Desk fills     | Hosted demo                         |
| 3   | 0:50-1:30 | At our store: pass and dispute     | Hosted demo, then **Live runs**     |
| 4   | 1:30-2:10 | Needs you: the held EUR 12.00 bill | Hosted demo                         |
| 5   | 2:10-2:45 | Why it was blocked: the replay     | Hosted demo                         |
| 6   | 2:45-3:10 | Real rails                         | **Live runs** (testnet and sandbox) |
| 7   | 3:10-3:30 | STOP                               | Hosted demo                         |
| 8   | 3:30-3:55 | The numbers, close on Flow         | Benchmark, Flow view                |

## 1. Cold open on Flow (0:00-0:15)

**On screen:** **Flow** view mid-run: requests from three agents pass through the warrant into
Paid, Held for you and Blocked, with the reasons beside Blocked.

**Narration:** "These three AI agents run a small data business. They buy, refund and pay bills
on their own. Warrant decides whether any of that money actually moves."

## 2. Run a scenario: the Desk fills (0:15-0:50)

**Setup:** **Reset**, then the Desk (press **Desk** if Flow is showing).

**On screen:** press **Run a scenario** in the three-step strip. Lines arrive in the middle
column, one sentence each, newest first: "Sourcing agent paid 0.02 USDZ to Upstream data
provider." and "Sourcing agent asked to pay 0.04 USDZ to Upstream data provider. Blocked." with
the reason under it. The 20-purchase burst folds into one blocked line marked "× 19". The left
column counts Needs you, Everything, Blocked, Paid and At our store, and shows each agent's budget
left.

**Narration:** "Agents never pay anyone. They ask, and every request is checked against the
warrant the owner signed. Paid, or blocked with the reason, in one sentence."

The burst: one purchase from that offer is paid (the one the offer allows) and every repeat is
blocked.

## 3. At our store: pass and dispute (0:50-1:30)

This is Metal's ask: dispute handling, and a seller proving an agent paid under a mandate a human
signed.

**On screen:** filter **At our store**. "Buyer's warrant pass checked" (the owner who signed, the
mandate, the cap against the price), "Buyer refused at the store" (no warrant pass: not served,
not charged), and a dispute decided order by order: one refunded for wrong data with its on-chain
transaction, the others kept ("data was correct", "order not found"). Then **Live runs**, the
Metal testnet dispute row: purchases `0x32a27368…` and `0x6f658444…` with their passes, the
refund by mandate pull `0x2314f9bc…`, the repeat refund refused, and "my agent never agreed"
rejected with 11 of 11 checks holding. Cut to the explorer page for the refund.

**Narration:** "Our store checks every buyer's warrant pass before serving: proof a real person
authorised that agent at that price. When a customer disputes, the store decides from its
records, order by order."

## 4. Needs you: the held EUR 12.00 bill (1:30-2:10)

**On screen:** **Needs you** at the top: "Treasury agent → Data licensor (EUR) · EUR 12.00",
reason "Data licensor (EUR) bills once a month and was already paid this month". The card on the
right shows exactly what is being approved and its fingerprint. Press **Approve EUR 12.00**; the
line moves to Paid and step 2 of the strip ticks.

**Narration:** "A second bill from the same licensor in the same month isn't the agent's call.
It waits for the owner, who sees exactly what they are approving, and approves that, and only
that."

Option: the same card on the phone page (narrow window, or **Phone** in the header).

## 5. Why it was blocked: the replay (2:10-2:45)

**On screen:** click the blocked 0.04 USDZ line. The right side shows it step by step: the
request, then "Rules: 1 of 9 failed" with each check ticked and "over the per-payment cap ·
0.04 USDZ > 0.03 USDZ" crossed, then the purpose check not run, then nothing reserved.

**Narration:** "Every decision can be replayed: which rule, which reason, what was held and what
moved. Nothing to take on trust."

## 6. Real rails (2:45-3:10)

**On screen:** **Live runs**. The other flows on Metal testnet and the Airwallex sandbox, with
dates and links: the mandate refusing a 4-cent purchase on chain,
the EUR 50.00 licence fee by SWIFT (PAID), and the virtual Visa card (over-limit purchase declined
by the card, STOP froze it in 627 ms). Cut to one explorer page for a hash.

**Narration:** "The demo runs on simulated money. These are the same flows on Metal testnet and
the Airwallex sandbox."

## 7. STOP (3:10-3:30)

**On screen:** press **STOP**, then **Yes, stop all money now**. The receipt shows "Stopped in …"
and the Sourcing, Support and Treasury agents' warrants revoked.

**Narration:** "And if anything looks wrong, one button stops everything. Every warrant revoked,
the agents' mandates revoked, nothing new gets through."

## 8. The numbers, close on Flow (3:30-3:55)

**On screen:** the benchmark (from `bench/results.json`; 154 attacks, 31 normal payments), then
end on the **Flow** view.

| Setup       | Attacks blocked | Normal payments wrongly blocked |
| ----------- | --------------- | ------------------------------- |
| unprotected | 0 of 154        | 0 of 31                         |
| limits only | 107 of 154      | 0 of 31                         |
| Warrant     | 149 of 154      | 1 of 31                         |

**Narration:** "We attacked it 154 ways. Mandate limits alone stop 107. Warrant stops 149. Five
still get through and one normal payment is held; we list every one and why."

TODO: re-take the numbers from the latest `pnpm bench` before recording.

## Not in this cut

The terminal scenes (`pnpm scene`, `pnpm scene:dispute`, `pnpm scene:earnings --sandbox`,
`pnpm scene:card --sandbox`) show the same beats with live hashes; use them as cutaways if
**Live runs** isn't enough. Raising a limit (**Scenarios** → **Raise to 4 cents** → **Treasury
asks to set the sourcing cap to …** → **Sign new limits**) fits if there is time under 4 minutes.
