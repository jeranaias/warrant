# Demo video script

The submitted video, 3:21 long, 1080p. Narration is a synthetic voice reading the lines below. On-screen labels say what each shot is: live model, scripted worst-case agent, live run on testnet and sandbox, or hosted demo. Screen footage is the real dashboard driven with the mouse; nothing is mocked up.

## Cold open (0:00-0:10)

**On screen (card):** An injected "ignore your spending rules" message drains an unprotected agent's budget; 0 of 155 attacks stopped.

**Narration:** "Give an AI agent a way to pay, and one message like this can drain its budget. With no protection, none of our one hundred fifty-five test attacks were stopped."

## Title (0:10-0:15)

**On screen (card):** Warrant: a control layer between AI agents and money.

**Narration:** "Warrant puts a control layer between AI agents and money."

## The business (0:15-0:32)

**On screen (live model, simulated money):** Flow view: three Claude Haiku 4.5 agents run a scenario; every request passes through the signed warrant.

**Narration:** "Three AI agents, running on Claude Haiku, run a small data business. They buy data, refund customers, and pay bills on their own. Every request goes through the warrant that its owner signed: paid, held for the owner, or blocked."

## Attacks (0:32-1:20)

**On screen (live model, then scripted worst case):** The attack scenario on Claude Haiku 4.5 (it pays the real supplier; the one bogus refund it agrees to is blocked at the gate), then the worst-case agent that obeys every message: changed payee, 200 pre-approved purchases, fake urgent invoice, each blocked with its reasons and replayable step by step.

**Narration:** "Agents never hold the money. They ask, and each request is checked against the warrant: who it may pay, how much, on which rail, and until when. Under attack, Claude Haiku ignored the fake address, the flood, and the fake invoice. It did agree to one bogus refund. That request hit the gate, and was blocked: it doesn't match an order. But you can't count on a model to say no. So we also test the worst case: an agent that obeys every message. A changed payment address? Not on the warrant. Blocked. Two hundred purchases the owner supposedly pre-approved? One goes through. Every repeat is blocked. A fake urgent invoice: blocked, with its reasons. And every decision replays, step by step."

## Needs you (1:20-1:33)

**On screen (live model):** A second EUR 12.00 licence bill in one month is held; the owner sees every field and approves exactly that.

**Narration:** "Some calls aren't for an agent to make. A second bill, from the same licensor, in one month, waits for the owner, who sees exactly what they're approving, and approves that, and only that."

## At our store (1:33-1:47)

**On screen (live model):** Our store checks each buyer's warrant pass before serving.

**Narration:** "On the other side, our store checks each buyer's warrant pass, before it serves anything: proof that a real person authorized that agent, at that price. No pass, no data, no charge."

## Real rails (1:47-2:03)

**On screen (live run, 14 Nov 2026):** One live run on Metal testnet and the Airwallex sandbox: an on-chain payment with its transaction hash, and the EUR 50 licence fee sent by SWIFT (scheduled).

**Narration:** "The demo runs on simulated money. These rails are real. Here, the same agents run against Metal testnet and the Airwallex sandbox, in one live run. Payments settle on chain, and a fifty-euro licence fee goes out by SWIFT."

## On chain (2:03-2:15)

**On screen (testnet runs):** Testnet runs: with Warrant's rules off, a 4-cent payment over the mandate's 3-cent cap is refused on chain.

**Narration:** "Every warrant sits on a Metal mandate, with the same limits. Turn Warrant's own rules off, and the chain still says no: a four-cent payment, over a three-cent cap, is refused on chain."

## Airwallex (2:15-2:31)

**On screen (sandbox runs):** USD global account -> EUR conversion -> SWIFT payout; a virtual Visa card with the same limits declines an over-limit purchase.

**Narration:** "On Airwallex, earnings land in a US dollar global account, convert to euros, and the licence fee is paid by SWIFT. A virtual Visa card carries the same limits. An over-limit purchase is blocked by our rules, and declined by the card."

## STOP (2:31-2:43)

**On screen (live run, 14 Nov 2026):** STOP on the live run: payments refused, 3 warrants and 2 Metal mandates revoked on chain (20.1 s, the chain confirmations).

**Narration:** "And if anything looks wrong, one button stops everything. Payments are refused at once. Every warrant is revoked, and on testnet, the mandates are revoked on chain."

## The numbers (2:43-3:01)

**On screen (card, from bench/results.json):** 155 attacks against the worst-case agent: no protection 0, mandate limits alone 110, Warrant 150; 5 get through, 1 of 30 normal payments wrongly blocked.

**Narration:** "Against that worst-case agent, we ran one hundred fifty-five attacks. Mandate limits alone stop one hundred ten. Warrant stops one hundred fifty. Five still get through, and one normal payment in thirty is wrongly blocked. Each one is listed, with the reason."

## Try it (3:01-3:08)

**On screen (hosted demo):** The hosted demo's Agents dialog: bring your own Anthropic key.

**Narration:** "Try it now, with no install. Bring your own Anthropic key, and watch a real model hit the same walls."

## Close (3:08-3:15)

**On screen (card):** Agents propose. Control decides. Money only leaves through control. Links and team.

**Narration:** "Agents propose. Control decides. Money only leaves through control."
