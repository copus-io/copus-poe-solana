# Copus PoE on Solana Devnet

## Run the complete demo locally

The repository includes the real English Copus UI. Start with Node.js 22+ and pnpm 10.15+:

```sh
pnpm install --frozen-lockfile
pnpm demo:product
```

First-time reviewers create their own testnet wallet/deployment and supply faucet gas. No private Copus checkout, production backend or shared issuer secret is required. **Follow the complete setup and expected click-by-click flow in [PRODUCT_DEMO.md](PRODUCT_DEMO.md).**


This repository ports Copus Proof of Experience (PoE) to Solana. Solana's [Devnet](https://solana.com/docs/references/clusters) is the public application test cluster; Solana's cluster named “Testnet” is primarily for validator and network stress tests. This implementation targets Devnet for a hackathon demo.

**Status:** the Solana program is deployed on Devnet and a funded proof and claim demo has succeeded. The matching Circom v2 verifier, SPL Token funding, encrypted batch issuer, private prover and relayer, finalized claim indexer, client transaction builders, and local end-to-end test are implemented. The SBF binary verifies a real proof under the normal 200,000 compute-unit limit. The Copus backend does not yet recognize Solana accounts or post Solana claims to the TIME ledger; the included settlement stub demonstrates idempotent credit locally.

## On-chain flow

1. The program upgrade authority initializes a singleton config with issuer, treasury and accepted SPL mint. The admin can rotate the issuer.
2. The issuer commits an evidence Merkle root and rule hash to a batch PDA.
3. The advertiser transfers an accepted SPL token directly to the treasury token account and creates a campaign PDA that fixes its manifest, rule hash, dates, TIME claim cap, period and ongoing or retrospective mode.
4. Anyone can relay a claim. The program checks the campaign, proof inputs, 24-hour evidence freshness for ongoing batches, epoch and cap, then creates a claim PDA keyed by campaign ID and nullifier. A second claim with that nullifier fails.

The five public Groth16 signals are exactly `evidenceRoot`, `ruleHash`, `nullifier`, `campaignId`, `epoch`, matching the original v2 circuit. The circuit enforces reading count, dwell time, time window and up to 12 Copus experience rules in `ALL` or `ANY` mode. The issuer remains the source of account-bound facts; the program cannot inspect Copus's private database.

## Verify locally

Install Rust, the Solana CLI with `cargo build-sbf`, Node.js 22 and pnpm. The source pins the `groth16-solana` revision. The proving key and verification key in `zk-v2-artifacts/` are a **fresh, Solana-only testnet ceremony**.

```sh
pnpm install --frozen-lockfile
pnpm test:client
cargo test -p copus-poe-solana
cargo build-sbf --manifest-path program/Cargo.toml
POE_TEST_SBF=1 SBF_OUT_DIR="$PWD/target/deploy" cargo test -p copus-poe-solana --test flow
```

The SBF test funds a campaign with a test SPL token, commits evidence, verifies a real Circom proof, rejects a changed proof, and rejects duplicate claiming. It also checks the treasury balance. A successful claim used about 122,000 compute units in the local test.

`pnpm circuit:setup:dev` generates another independent local test setup using fresh random contributions; run `pnpm proof:fixture` and rebuild the program afterward. The test setup is not a production multi-party trusted ceremony. Never combine this proof key with the Base Sepolia or Monad verifiers.

## Deploy and run the Devnet demo

The public Devnet program ID is `8oUVMRStpkqaFCDSdqvP4fM7AEgv4CCEqJ4gu3jsoR65`. The first isolated demo used freely mintable SPL mint `7rTS5A4QTWLo1SbuMV3jXxtqmUcBqz2nLKDNM4EkjTyr`, committed batch `1`, funded campaign `1`, and completed a [proof claim](https://explorer.solana.com/tx/2vzAKu1hcWWqjx9Lvk62NXn22AtHDwyEXDsi5tHEMpRQ8mqBwQUevxRS53aeSnHu5prGzgNftNnqZ5zni51rvPcm?cluster=devnet). The [funding transaction](https://explorer.solana.com/tx/2aG3nNxxmojFbHVzAwukJkpjsEnzRcjJp53VBmcodRYqDDry4WQwvGUCLrr54YPyT46QNE6msDkjdNwSX4XR7VvY?cluster=devnet) transferred one test token to the demo treasury. This is public fixture evidence, not a Copus account-bound receipt or TIME credit.

The program binary is `target/deploy/copus_poe_solana.so`. Keep the generated program keypair and payer keypair outside Git. Fund the payer with Devnet SOL, then deploy with the same payer as the future config administrator:

```sh
solana program deploy --url devnet --keypair /path/to/payer.json \
  --program-id /path/to/program-keypair.json target/deploy/copus_poe_solana.so
```

Set `SOLANA_KEYPAIR_PATH`, `POE_PROGRAM_ID`, and a different `POE_TREASURY_ADDRESS`; optionally set `SOLANA_RPC_URL` to a Devnet RPC. Run `pnpm demo:devnet` against a newly deployed program. The demo creates a freely mintable six-decimal SPL token, commits a public test fixture, funds one campaign, claims with a real proof, and checks the claim PDA and treasury balance. It does not mint real USDC or credit TIME.

For a private batch, prepare policy and receipt JSON files outside Git, set `BATCH_ENCRYPTION_KEY` to 64 random hex characters, and run `pnpm issuer:batch`. The issuer commits the Merkle root and writes receipt paths only to an AES-GCM encrypted archive with owner-only permissions. `pnpm prover` accepts a receipt and path over a bearer-authenticated loopback API. `pnpm relayer` registers the authenticated Copus subject mapping before sending a claim.

For the local settlement loop, set distinct `SETTLEMENT_TOKEN`, `RELAYER_TOKEN` and `PROVER_TOKEN` values from `.env.example`. If claiming directly through the demo script, register a subject mapping first with `node services/indexer.js register 1 <nullifier-hex> demo-reader`, using the fixture's `nullifier` field. Run `pnpm settlement:stub` and `pnpm indexer` in separate terminals. The indexer scans finalized transactions, validates the claim PDA and campaign data, and POSTs one idempotent `timeSeconds` credit to the local stub. These services do not write to Copus's production TIME ledger.

The program ID, payer and treasury public keys may be shared; **never commit the keypair JSON files**. The demo fixture is public data and must not be used as an account-bound real-user receipt. A production integration needs a Solana wallet-to-Copus-subject binding, authenticated fact issuance, and idempotent TIME settlement in the Copus backend.

See [Solana's program model](https://solana.com/docs/core/programs) and the [Groth16 Solana verifier](https://github.com/Lightprotocol/groth16-solana) used here.

## Actual Copus product demo

Run `pnpm demo:product` with [PRODUCT_DEMO.md](PRODUCT_DEMO.md). This connects the actual sponsor editor, reader card, clock and isolated TIME ledger to the matching v2 chain verifier. [SUBMISSION.md](SUBMISSION.md) contains only technical recording/evidence steps. The on-chain transactions are real; experience summaries and TIME balances are explicitly labeled demo fixtures.

## Latest real UI acceptance (2026-10-04)

The bundled UI created campaign 2, completed a [real proof claim](https://explorer.solana.com/tx/3inY3j6mYyYrRnFPu8eod28Z1bcmDgUWUFFutdPq2y3yjh2y6UqvYDE2SejnTkQb7HEimPbjiQNZsuA19vgyttpP?cluster=devnet) after [test-token funding](https://explorer.solana.com/tx/4gMiyjPVPTR5pzjhLcz3Qhqtt1UgKWYGs7ReGSusDRuCGzoz2MqX5JmYkKZNBGi7g1Tru4KUVD7ke7k4ikQZVHpd?cluster=devnet), credited 30 minutes and settled 13 seconds of reading. The browser made no external API requests. See [demo-evidence.json](demo-evidence.json) for exact network identifiers and checks.
