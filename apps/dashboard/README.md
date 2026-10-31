# Owner dashboard

The owner's screen: what each agent has spent against its budget, what is waiting for a
decision, a STOP button, the on-chain mandates and a live activity feed. Mock rails only.

## Run it

In two terminals from the repo root:

```sh
pnpm engine      # the engine on http://127.0.0.1:4000
pnpm dashboard   # the dashboard on http://localhost:5173
```

Open http://localhost:5173. The phone view is http://localhost:5173/#/m.

The dashboard calls `/api/...` and the Vite dev server forwards it to the engine (see
`vite.config.ts`), so the engine needs no CORS. If the engine runs on another port, start both
with the same `ENGINE_PORT`.

The feed only moves when something calls the engine: run the agents (lane A), or use Scene
control (raise the price, load a scenario, have treasury ask for a new cap).

## Where things live

| Screen            | File                            | Engine calls                        |
| ----------------- | ------------------------------- | ----------------------------------- |
| Waiting for you   | `src/components/Approvals.tsx`  | `GET /approvals`, `POST /approvals` |
| Agents and budget | `src/components/Balances.tsx`   | `GET /world`                        |
| STOP              | `src/components/StopButton.tsx` | `POST /kill`, `GET /kill`           |
| On-chain mandates | `src/components/Chain.tsx`      | `GET /chain`                        |
| Scene control     | `src/components/Scene.tsx`      | `/upstream/price`, `/scenario`, ... |
| Live activity     | `src/components/Activity.tsx`   | `GET /events?since=`                |
| Phone (`#/m`)     | `src/components/Phone.tsx`      | same as above                       |

- `src/api.ts`: every engine call and its response type. Add new endpoints here first.
- `src/format.ts`: all wording (event lines, field labels, agent names) and money formatting.
  Tests in `src/format.test.ts`.
- `src/useEngine.ts`: polling (`POLL_MS`).
- `src/styles.css`: colors are tokens at the top (light and dark).

## Rules

See `CLAUDE.md`. In short: never import rails or agents; the approval card shows every field of
what is approved; the stop is one click plus a confirm; no card numbers or keys on screen.

## Phone view on a real phone

`pnpm dashboard --host` exposes the dev server (and through it the engine) on your network.
There is no owner login yet, so anyone on that network could approve or stop. Use it only on a
network you trust, for the demo.
