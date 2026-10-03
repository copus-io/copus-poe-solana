# Review the Solana demo

## Requirements

- Node.js 22+, pnpm 10.15+, an internet connection and Devnet SOL for gas.
- The Solana/Agave CLI for a first-time program deployment: <https://docs.anza.xyz/cli/install>. The matching compiled program is included in `program-binary/`; building Rust is optional for the UI walkthrough.
- The real Copus UI is bundled in `demo-ui/copus-ui.tar.gz`; its hash and frontend commit are recorded in `demo-ui/manifest.json`. You do not need access to the private frontend repository.
- All blockchain actions run on **Solana Devnet**. The normal review command never falls back to a local validator or mainnet.

## Start from a fresh clone

```sh
git clone https://github.com/copus-io/copus-poe-solana.git
cd copus-poe-solana
pnpm install --frozen-lockfile
pnpm demo:product
```

On the first run, the command generates owner-only operator and program keypairs under `~/.local/share/copus-poe-review/solana/`. It attempts a Devnet airdrop. If the faucet is rate limited or more gas is needed, it prints **only the public address** and stops. Fund that address with Devnet SOL at <https://faucet.solana.com>, then rerun `pnpm demo:product`. Allow enough Devnet SOL for a program deployment and subsequent transactions. At least 3 Devnet SOL is recommended for initial deployment. The command deploys your own native program and config, a separate treasury and a freely mintable SPL test token. It does not change the published Copus deployment and does not require a Copus issuer's private key.

After setup, open **http://localhost:8792/time-sponsors?sponsorshipDemo=1**. Keep the command running. Subsequent starts reuse the wallet, deployment and isolated ledger. To run another instance use `POE_DEMO_PORT=8793 pnpm demo:product`.

## Expected UI walkthrough

1. **Create a sponsorship.** The editor starts with an English campaign. Adjust the brand, title, description, cover, budget and claim amount. The preview is the actual reader card.
2. **Set eligibility.** Add public conditions, choose all/any matching and optionally add private conditions. Private values do not appear on the reader card. Experience facts are fixed demo fixtures, not production user records.
3. **Continue to funding.** Click **Confirm and continue to funding**. This opens the payment page directly; there is no extra review/save-plan screen.
4. **Fund and publish.** Click **Fund and publish**. A real transaction transfers **1 freely mintable test token** to the treasury and publishes the campaign. The USD budget shown in the editor is a product preview, not a real charge or a TIME exchange rate. Open the funding transaction link if you want to inspect the receipt.
5. **Open the claim card.** Click **Open claim card**. Default campaigns start approximately 30 seconds after funding; allow the card to refresh. Conditions use readable English such as “Published at least 1 work.”
6. **Claim TIME.** Click **Claim 30 minutes**. The local issuer commits a real evidence batch, privately generates a Groth16 proof and submits it to the on-chain v2 verifier. The button waits for confirmation; there is no “Proof submitted” toast. Only a finalized claim PDA and matching transaction credit the demo ledger. The left clock briefly shows green **+00:30:00**.
7. **Inspect the balance and sponsor.** Open the left TIME clock. It shows the remaining balance and the sponsor's cover, name, title, full description and link. The balance decreases while exploring; the timing UI reuses Copus's normal attention runtime.
8. **Inspect the ledger.** Open **View TIME activity**. A sponsored credit and settled reading debits appear. Closing and reopening a reading session cannot debit twice. The claimed campaign cannot be claimed twice in the same period.

The page scrolls on desktop and mobile. No test-controls banner or technical network/verifier label is shown on the reader card. The network is identifiable through transaction links and the command's startup output.

## Existing authorized deployment (operators)

If you already have an issuer authorized on a matching deployment, set these variables before the normal command:

```sh
export SOLANA_KEYPAIR_PATH=/private/path/to/devnet-issuer.json  # 64-byte keypair; chmod 600
export POE_PROGRAM_ID=8oUVMRStpkqaFCDSdqvP4fM7AEgv4CCEqJ4gu3jsoR65
export POE_REVIEW_DATA=/private/path/to/review-data
export SOLANA_RPC_URL=https://api.devnet.solana.com
# Optional for environments that require an RPC proxy:
export POE_RPC_PROXY=http://127.0.0.1:17891
pnpm demo:product
```

Never commit wallets or copy another deployment's proving key. The operator must be an authorized issuer. Our published deployment addresses and prior transactions are recorded in the README for independent inspection; they are not credentials for the review demo.

## Isolation and checks

The browser only calls the local demo service. Its CSP blocks external fetch/XHR connections. It does not send Copus account tokens, contact Copus's production APIs, read a production database or change production TIME. Cookie sessions are HMAC-signed; browser-selected subjects, epochs and issuer facts are ignored. Wallets, sessions and SQLite files remain outside Git. Closing the command stops the app; it does not delete your private local data.

Chain funding and verification are real. Experience inputs and TIME credits are explicitly a fixture-based, isolated demonstration. This is not a production ledger integration or an audit claim. The app's public-content feed is disabled rather than fetched from the production backend.

```sh
pnpm test:client
cargo test --locked -p copus-poe-solana
pnpm verify:demo
```

The advanced `pnpm demo:frontend-dev` command is for maintainers with a local current Copus frontend; it is not needed by reviewers.

## Why Devnet?

Solana recommends Devnet for application developers; its cluster called Testnet primarily tests validator/network releases. This app verifies the Devnet genesis hash and refuses mainnet or a different cluster. See <https://solana.com/docs/references/clusters>.

Indexer retry operations:

```sh
node services/indexer.js quarantine
node services/indexer.js retry <signature>
```

Unmapped/failed signatures back off and enter quarantine, so they cannot starve later valid claims. Settlement replay is idempotent; both top-level and CPI claims validate their accounts.
