# WebAuthn Tutorial

This repository walks through building a WebAuthn-secured smart account on Sepolia. It combines a Foundry project that implements the account logic, a Cloudflare Worker that mints accounts, watches USDC deposits, and crafts ERC-4337 user operations, plus a React client that drives the WebAuthn ceremony and user flow. Together they demonstrate how hardware-backed credentials can authorize on-chain activity without traditional private keys.

```
Browser (client) ──WebAuthn──▶ Cloudflare Worker (server) ──handleOps──▶ EntryPoint v0.8
        ▲                                                   │
        └────── polls deposits & refunds ◀── USDC token ◀───┘
```

## Repository layout

| Path | What lives here |
| --- | --- |
| `client/` | React + Vite UI that registers a WebAuthn credential, deploys a smart account, shows incoming Sepolia USDC deposits, and issues refunds |
| `server/` | Hono app running on Cloudflare Workers; deploys `AccountWebAuthn` clones, watches ERC-20 transfers, and submits ERC-4337 user operations through EntryPoint v0.8 |
| `contract/` | Foundry workspace containing `AccountWebAuthn`, `AccountFactory`, and auxiliary sample contracts |
| `shared/` | TypeScript module that exports all shared addresses/ABIs (EntryPoint, USDC, factory, account) so the client and worker stay in sync |

## Prerequisites

- Node.js 20+ and [pnpm](https://pnpm.io/) 9+ (for `client/` and `server/`)
- [Foundry](https://book.getfoundry.sh/) (for `contract/`)
- [Wrangler 4](https://developers.cloudflare.com/workers/wrangler/) configured with a Cloudflare account
- A Sepolia RPC endpoint (Infura, Alchemy, etc.) and a funded Sepolia EOAs private key that can deploy/fund smart accounts and pay for refunds
- Sepolia ETH and USDC for testing deposits (the worker treats anything ≥1 USDC as refundable)

## Install dependencies

```bash
# Client UI
cd client
pnpm install

# Cloudflare Worker
cd ../server
pnpm install

# Optionally, install Foundry deps
cd ../contract
forge install
```

## Configure the worker

Create `server/.dev.vars` (used by `wrangler dev`/Vite) or set Wrangler secrets in production:

```
RPC_URL="https://sepolia.infura.io/v3/<project>"
PRIVATE_KEY="0xabc123..."
```

- `RPC_URL` must point to an HTTPS Sepolia endpoint that supports `eth_getLogs`.
- `PRIVATE_KEY` should hold enough ETH to pay for factory deployments, initial smart-account funding (5 mETH) and EntryPoint gas for refunds. Never reuse a wallet that secures real value.

To store the same values for Cloudflare deployments, run:

```bash
cd server
wrangler secret put RPC_URL
wrangler secret put PRIVATE_KEY
```

## Run everything locally

1. **Start the worker**  
   ```bash
   cd server
   pnpm dev      # serves on http://localhost:8787
   ```

2. **Run the client**  
   ```bash
   cd client
   pnpm dev -- --open   # defaults to http://localhost:5173
   ```
   The client expects the worker at `http://localhost:8787`. To point elsewhere, update the `SERVER_URL` constant in `client/src/App.tsx`.

3. **Walk through the flow**
   - Click **Create account** to generate a WebAuthn credential (using the `ox` WebAuthn helpers) and ask the worker to clone and initialize an `AccountWebAuthn` smart account through the `AccountFactory`.
   - The worker funds the new account with ETH, starts watching Sepolia USDC `Transfer` events, and streams deposits back to the UI via `/account/:address/deposits`.
   - Send ≥1 Sepolia USDC to the displayed account address (from a faucet or another wallet). When a deposit is marked “ready”, pick it in the UI and press **Refund**.
   - The client creates a ERC-4337 `PackedUserOperation` that transfers USDC back to the original sender. Your authenticator signs the structured data, the worker validates it, simulates `handleOps`, and submits it through EntryPoint v0.8.

## Worker API reference

All endpoints live on the worker host (localhost:8787 in dev):

| Method & path | Description |
| --- | --- |
| `POST /account/create` | Body: `{ credentialId, publicKey: { x, y } }`. Deploys (or reuses) an account clone, funds it with ETH, starts a deposit watcher, and returns `{ accountAddress, transactionHash, fundingTransactionHash }`. |
| `GET /account/:address/deposits` | Streams cached deposit records for the account plus watcher status (`ready` means the deposit is ≥1 USDC and refundable). |
| `POST /account/refund` | Validates a signed user operation (WebAuthn metadata, `r/s`, and encoded call), simulates EntryPoint `handleOps`, and broadcasts the transaction. Marks the deposit as refunded on success. |

The worker keeps sessions in memory; restarting it clears watchers and you must recreate/re-register accounts for testing.

## Smart contracts (`contract/`)

- `AccountWebAuthn.sol` extends OpenZeppelin’s `Account`, `ERC7739`, and `SignerWebAuthn` helpers. On initialization it stores the authenticator’s P-256 public key and only executes bundles signed by that credential (or EntryPoint when executing ops).
- `AccountFactory.sol` is a deterministic clone factory that predicts addresses for a given initializer and deploys/funds them on demand.
- `MyNFT.sol` is a simple sample token contract for experimentation.

Useful commands:

```bash
cd contract
forge build          # compile contracts
forge test           # run the Foundry test suite
forge script ...     # deploy scripts (see foundry.toml)
```

The factory and EntryPoint/USDC addresses exported from `shared/` currently reference Sepolia deployments:

- `FACTORY_ADDRESS = 0x7F3505c23FD8ef643447D528E34beb3aF90C4A47`
- `ENTRYPOINT_ADDRESS = 0x4337084d9e255ff0702461cf8895ce9e3b5ff108` (EntryPoint v0.8)
- `USDC_ADDRESS = 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`

Update these constants if you redeploy to a different network.

## Build & deploy

- **Client**: `pnpm build` emits static assets to `client/dist/`, ready for any static host (Cloudflare Pages, Vercel, S3, etc.).
- **Worker**: `pnpm deploy` builds and publishes via Wrangler. Ensure `RPC_URL`/`PRIVATE_KEY` are stored as Cloudflare secrets first.

## Troubleshooting tips

- Deposits smaller than `10 ** USDC_DECIMALS` (1 USDC) are tracked but never marked `ready`, so refunds stay disabled.
- If polling `/account/:address/deposits` returns `watching: false`, restart the worker; it spins up a fresh `viem` log watcher.
- WebAuthn credentials are bound to the browser profile and origin. Use the same host/port when reloading or you will be prompted to register again.
- EntryPoint reverts usually mean the USDC transfer arguments do not match the stored deposit. Confirm the client sent the same `txHash`, `logIndex`, and amount the worker recorded.

Happy hacking!
