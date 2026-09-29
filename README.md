# Copus PoE on Solana Devnet

This repository ports Copus Proof of Experience (PoE) to Solana. Solana's [Devnet](https://solana.com/docs/references/clusters) is the public application test cluster; Solana's cluster named “Testnet” is primarily for validator and network stress tests. This implementation targets Devnet for a hackathon demo.

**Status:** the Solana program, matching Circom v2 verifier, SPL Token funding, private prover service, finalized claim indexer, client transaction builders, and local end-to-end test are implemented. The SBF binary builds and executes a real proof under the normal 200,000 compute-unit limit. Devnet deployment is pending faucet funding. The Copus backend does not yet recognize Solana accounts or post Solana claims to the TIME ledger; the included settlement stub demonstrates idempotent credit locally.

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

The program binary is `target/deploy/copus_poe_solana.so`. Keep the generated program keypair and payer keypair outside Git. Fund the payer with Devnet SOL, then deploy with the same payer as the future config administrator:

```sh
solana program deploy --url devnet --keypair /path/to/payer.json \
  --program-id /path/to/program-keypair.json target/deploy/copus_poe_solana.so
```

Set `SOLANA_KEYPAIR_PATH`, `POE_PROGRAM_ID`, and a different `POE_TREASURY_ADDRESS`; optionally set `SOLANA_RPC_URL` to a Devnet RPC. Run `pnpm demo:devnet` against a newly deployed program. The demo creates a freely mintable six-decimal SPL token, commits a public test fixture, funds one campaign, claims with a real proof, and checks the claim PDA and treasury balance. It does not mint real USDC or credit TIME.

For the local settlement loop, set distinct `SETTLEMENT_TOKEN` and `PROVER_TOKEN` values from `.env.example`. Register a subject mapping before the claim with `node services/indexer.js register 1 <nullifier-hex> demo-reader`, using the fixture's `nullifier` field. Run `pnpm settlement:stub` and `pnpm indexer` in separate terminals. The indexer scans finalized transactions, validates the claim PDA and campaign data, and POSTs one idempotent `timeSeconds` credit to the local stub. `pnpm prover` exposes the private v2 proof service on loopback; it requires bearer auth. These services do not write to Copus's production TIME ledger.

The program ID, payer and treasury public keys may be shared; **never commit the keypair JSON files**. The demo fixture is public data and must not be used as an account-bound real-user receipt. A production integration needs a Solana wallet-to-Copus-subject binding, authenticated fact issuance, and idempotent TIME settlement in the Copus backend.

See [Solana's program model](https://solana.com/docs/core/programs) and the [Groth16 Solana verifier](https://github.com/Lightprotocol/groth16-solana) used here.
