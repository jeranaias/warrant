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

- Create your own sandbox account at https://demo.airwallex.com.
- Create an API key (client id + key) and put them in `.env`.
- Base URL: `https://api-demo.airwallex.com`.

## 4. Metal testnet

- Get a testnet API key and payer wallet; fund it from the faucet.
- Put `METAL_API_KEY` and `METAL_PAYER_WALLET_ID` in `.env`.

## 5. Claude Code + Airwallex MCPs

The repo's `.mcp.json` registers two Airwallex sandbox MCP servers:

| Name                  | URL                                         | Use                                  |
| --------------------- | ------------------------------------------- | ------------------------------------ |
| `airwallex-docs`      | https://mcp.sandbox.airwallex.com/docs      | Search Airwallex API docs            |
| `airwallex-developer` | https://mcp.sandbox.airwallex.com/developer | Developer tools against your sandbox |

Open Claude Code in the repo root, approve the project MCP servers when prompted, then run `/mcp`
to check both are connected (authenticate if asked). Use the docs MCP before writing any rails or
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
