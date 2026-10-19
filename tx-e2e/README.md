# /tx end-to-end harness

Runs the /tx approval page and the MCP endpoint against the real PoidhV3
contract on an anvil fork of Base. No real funds.

- `brew install foundry`, then `anvil --fork-url https://mainnet.base.org`
- poidh-app: `next dev -p 3123` (for `mcp-agent.mjs`, also set
  `BASE_RPC_URL=http://127.0.0.1:8545` plus the other required server env)
- here: `npm i playwright-core@1.56.1 viem@2.21.0`, generate `abi.cjs` from
  `src/constant/abi/abi.ts`, then `node all-actions.mjs` / `node mcp-agent.mjs`

Only poidh's DB-backed tRPC reads are stubbed, and they are answered from live
fork state (page id = onchain id + 100000, so id mix-ups fail loudly).
