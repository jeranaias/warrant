# Runbook: setup

## 1. Tools

- Node 24 LTS (`.nvmrc`), pnpm 10 (`corepack enable` then `corepack prepare pnpm@10 --activate`)
- Git, and the GitHub CLI if you like it.

```sh
git clone <repo-url> warrant && cd warrant
pnpm install
pnpm verify      # must pass before you start
```

## 2. Secrets

```sh
cp .env.example .env
```

Fill in **sandbox / testnet** values only. `.env` is gitignored; never commit it, paste it into a
prompt, or log it. Leave `RAILS_MODE=mock` until your sandbox access works.

## 3. Airwallex sandbox

- Sign up for your own sandbox account: https://www.sandbox.airwallex.com/global/signup
- Sandbox web app: https://www.sandbox.airwallex.com/app
- In the web app, create an API key (client id + API key) and put both in `.env`.
- API base URL: `https://api.sandbox.airwallex.com` (auth: `POST /api/v1/authentication/login`
  with `x-client-id` and `x-api-key` headers, returns a short-lived bearer token).
- Reference: https://www.airwallex.com/docs/developer-tools/sandbox-environment

## 4. Metal testnet

Each teammate uses their **own** test account. Keys and credentials live in `METAL_HOME`, a folder
outside the repo (for example `~/.metal-agent`). Never commit, paste or share anything in it, and
never delete it: losing the only owner key loses control of that account.

1. Create an RPC endpoint at https://console-testnet.metalntwx.com/endpoints and copy its full HTTP
   URL into `METAL_RPC_URL` in `.env`. (The console's sandbox page is not the RPC URL. Console
   credits are not USDZ.) Check it:

   ```sh
   curl -sS -X POST "$METAL_RPC_URL" -H 'Content-Type: application/json'      -d '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}'
   # expect "result":"0xf951"  (chain 63825)
   ```

2. Install the CLI (pinned, ADR-010) and make an owner account:

   ```sh
   npm install -g @metalntwx/metal-agent@0.3.3
   mkdir -p ~/.metal-agent && chmod 700 ~/.metal-agent
   metal-agent account create --out ~/.metal-agent/owner.json --network testnet
   export METAL_ACCOUNT=0x...        # the smart account address it printed
   metal-agent fund "$METAL_ACCOUNT" --network testnet   # faucet: 100 test USDZ
   ```

3. Make and bind a mandate (example: the sourcing numbers from ADR-009):

   ```sh
   metal-agent mandate credential create --principal "$METAL_ACCOUNT"      --cap 0.03 --budget 10 --expires-in 86400      --key ~/.metal-agent/owner.json --out ~/.metal-agent/sourcing.json --network testnet
   chmod 600 ~/.metal-agent/*.json
   metal-agent mandate bind --credential ~/.metal-agent/sourcing.json      --key ~/.metal-agent/owner.json --network testnet
   metal-agent mandate status --credential ~/.metal-agent/sourcing.json --network testnet
   # expect: bound yes, revoked no, spent 0, payments 0
   ```

4. Pay Metal's demo seller under the mandate:

   ```sh
   metal-agent pay https://x402-demo-testnet.metalntwx.com/quote      --mandate ~/.metal-agent/sourcing.json --network testnet
   # expect: status 200, amount 0.01 *USDZ, transaction 0x...
   ```

Gotchas (from the team's first run, 2026-10-29):

| Symptom                                     | Fix                                                                    |
| ------------------------------------------- | ---------------------------------------------------------------------- |
| `--principal` missing                       | `$METAL_ACCOUNT` is empty; set it and `echo` it.                       |
| `sourcing.json already exists`              | The CLI never overwrites a credential. Use a new `--out` name.         |
| `payment refused: transfer_would_fail`      | The account is not funded. Run `fund`, then retry.                     |
| `--key` vs `--out`                          | `--key` is the existing owner key; `--out` is the new credential file. |
| Mandate stopped working after an hour       | It expired (`--expires-in`). Make and bind a new one.                  |
| `a payment was signed and may have settled` | Do not pay again. It is unconfirmed: look it up first (ADR-010).       |

Reference: https://docs.metalntwx.com/agents/metal-agent.md (every command),
https://docs.metalntwx.com/agents/require-signed-order.md (our store's route).

## 5. Claude Code + Airwallex MCPs

The repo's `.mcp.json` registers two Airwallex sandbox MCP servers:

| Name                  | URL                                         | Use                                  |
| --------------------- | ------------------------------------------- | ------------------------------------ |
| `airwallex-docs`      | https://mcp.sandbox.airwallex.com/docs      | Search Airwallex API docs            |
| `airwallex-developer` | https://mcp.sandbox.airwallex.com/developer | Developer tools against your sandbox |

Open Claude Code in the repo root, approve the project MCP servers when prompted, then run `/mcp`
to check both are connected. The docs MCP needs no login. The developer MCP uses OAuth: pick it
in `/mcp` and sign in with **your own sandbox account**. Use the docs MCP before writing any rails or
mock code, so API shapes match the real sandbox.

## 6. Run things

```sh
pnpm mocks       # mock Airwallex + Metal
pnpm dashboard   # owner UI
pnpm bench       # benchmark
```

## Troubleshooting

- `pnpm install` fails on the lockfile in CI: run `pnpm install` locally and commit
  `pnpm-lock.yaml`.
- A rail call timed out: it is **unconfirmed**, not failed. Check status before doing anything.
