# Review the Solana demo

## Requirements

- Node.js 22+, pnpm 10.15+, an internet connection and Devnet SOL for gas.
- The Solana/Agave CLI for a first-time program deployment: <https://docs.anza.xyz/cli/install>. The matching compiled program is included in `program-binary/`; building Rust is optional for the UI walkthrough.
- The real Copus UI is bundled in `demo-ui/copus-ui.tar.gz`; its hash and frontend commit are recorded in `demo-ui/manifest.json`. You do not need access to the private frontend repository.
- By default, all blockchain actions run on **Solana Devnet**. The normal review command never falls back to a local validator or mainnet.

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

1. **Apply and create a sponsorship.** Open **Sponsor TIME** to see the advertiser introduction, then click **Start sponsoring** or the **Apply to sponsor** button. The demo approves immediately and opens the campaign panel without a contact form or review wait. Approval is saved to your local demo session. The editor starts with an English campaign. Adjust the brand, title, description, cover, budget and claim amount. The preview is the actual reader card.
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

Solana recommends Devnet for application developers; its cluster called Testnet primarily tests validator/network releases. The normal review command verifies the Devnet genesis hash and refuses mainnet or a different cluster. The explicit local mode described above permits a loopback validator. See <https://solana.com/docs/references/clusters>.

Indexer retry operations:

```sh
node services/indexer.js quarantine
node services/indexer.js retry <signature>
```

Unmapped/failed signatures back off and enter quarantine, so they cannot starve later valid claims. Settlement replay is idempotent; both top-level and CPI claims validate their accounts.

## Run against a local Solana validator

The explicit local mode uses a fresh local chain (not a Devnet fork), a separate operator/program, and free local SOL. The normal `demo:product` command still requires Devnet.

```sh
# Terminal 1; keep running. Resume this ledger on subsequent starts.
solana-test-validator --ledger .review-data/solana-local/validator --rpc-port 8899 --bind-address 127.0.0.1 --quiet

# Terminal 2
POE_REVIEW_DATA="$PWD/.review-data/solana-local" pnpm demo:local
```

Open http://localhost:8792/time-sponsors?sponsorshipDemo=1 and follow the walkthrough above. The launcher deploys the checked-in program binary, initializes its config and SPL test mint, and funds its isolated operator through the local faucet. `POE_LOCAL_RPC_URL` can select another loopback HTTP RPC port. Local mode does not use `SOLANA_KEYPAIR_PATH` or `POE_PROGRAM_ID` from a Devnet setup. Local transaction signatures have no public explorer link; inspect them through the local RPC or `solana confirm -v --url http://127.0.0.1:8899 <signature>`.

Stop both commands with Ctrl-C when finished. Preserve `.review-data/solana-local/` to resume the same chain and ledger; do not reset only the validator while retaining the application's TIME ledger.

### Create navigation

The bottom/side **Create** entry is for publishing works, which is not connected to a publishing backend in this isolated demo. It displays an explanation and links to **Create a sponsorship**, **Claim TIME**, and **View TIME activity**, including on direct `/create` loads and client-side navigation. This matches the Monad demo's entry behavior; it does not implement work publishing.

### Local TIME ledger API

`GET /client/user/time/ledger?direction=ALL&pageIndex=1&pageSize=30` returns only the signed session's records. `direction` accepts `ALL`, `IN` (settled sponsorship credits), or `OUT` (settled attention debits). Filtering precedes counting and pagination; `pageIndex` is one-based (maximum 1,000,000) and `pageSize` is 1–100. Rows sort newest first, with stable ID ordering for equal timestamps. The demo returns individual entries (`entryCount: 1`); `merge=true` does not aggregate them. Group expansion is not implemented.

New credits retain their local settlement timestamp, including reconciliation; debits retain their session-close timestamp across repeated closes. Legacy credits have `createTime: null` and `timeSource: UNKNOWN` because the previous database did not store their dates. Unknown dates sort last; no historical timestamp is invented. Legacy closed sessions retain their previously recorded `last_seen` value as the best available close timestamp.

Credit rows include `campaignId`, `sponsorId` (the demo campaign ID), `sponsorName`, `fromUsername`, `campaignTitle`, and `transactionHash`. The bundled frontend currently overrides individual SPONSOR row names with the account's current sponsor and does not format unknown dates explicitly; these presentation changes require a frontend update. The API supplies the correct per-entry values without changing the bundled frontend.

Run the focused API regression tests with `node --test test/product-ledger.test.js`. They use an in-memory ledger and a test chain adapter, without broadcasting transactions.

### Campaign schedule and Top sponsors

The editor validates dates before opening funding: an explicit start must be in the future; turning off **No end date** requires an end later than the start. A blank start defaults to approximately 30 seconds after preparation completes, immediately before constructing the campaign-creation transaction. The API revalidates before queueing funding and after waiting for the transaction queue. Both chain adapters validate before committing evidence, minting or approving tokens, then revalidate after these confirmations. An explicit start is never silently moved; if it has passed, or the end no longer follows the refreshed default start, creation is rejected. Already-confirmed preparation transactions are not rolled back. The creation transaction itself must still land before its start time; delayed inclusion can still be rejected by the chain. The Monad in-process demo no longer fast-forwards chain time during publication; future campaigns remain scheduled.

Sponsor cards expose `poeScheduleStatus` (`SCHEDULED`, `ACTIVE`, `ENDED`) and ISO `startsAt`. Before the start they show **Starts soon / 尚未开始**, and after the end **Campaign ended / 活动已结束**; eligibility is evaluated for claiming only during the active window. The claim API rejects premature and ended claims before creating a pending claim or calling the chain. Server time drives the displayed status; the contract/program still enforces chain time.

`GET /client/user/time/ledger/top-sponsors` returns the current signed session's settled sponsorship credits, grouped by campaign and ranked by total credited seconds (descending, campaign ID as a stable tie-breaker). Entries contain `sourceType: BRAND`, `sourceId` (campaign ID), `name`, `description`, and `totalSeconds`. Pending, expired and other readers' claims are excluded. An empty array is correct when the reader has no settled sponsorships. This uses the demo's existing local settlement ledger; no additional chain scanning service is introduced.

The checksummed frontend archive is preserved. `services/demo-ui-patches.js` adapts its known modern and legacy editor/card hooks when served by `services/product-web.js`. If the frontend archive is replaced, rerun `node --test test/demo-ui-patches.test.js` and update these hooks as needed. The focused API/state tests are in `test/product-ledger.test.js`. These changes are local to the two demo repositories, not a deployment of the production Copus frontend.
