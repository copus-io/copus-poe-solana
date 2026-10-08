#!/usr/bin/env bash
# Upgrade only the checked-in, verified Devnet demo program; never mainnet.
set -euo pipefail
cd "$(dirname "$0")/.."
[[ -z "$(git status --porcelain)" ]] || { echo 'Clean committed source required'; exit 1; }
pnpm verify:demo
rpc=https://api.devnet.solana.com
[[ "$(solana genesis-hash --url "$rpc")" == EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG ]] || exit 1
key="${POE_DEMO_HOME:?Private runtime required}/secrets/operator.json"
program=8oUVMRStpkqaFCDSdqvP4fM7AEgv4CCEqJ4gu3jsoR65
operator=$(solana-keygen pubkey "$key")
solana program show "$program" --url "$rpc" --output json > /tmp/copus-poe-devnet-program-info.json
python3 - "$operator" <<'PY'
import json,sys
with open('/tmp/copus-poe-devnet-program-info.json') as f: v=json.load(f)
assert v.get('authority')==sys.argv[1], 'Operator must be the existing upgrade authority'
PY
solana program deploy --url "$rpc" --keypair "$key" --upgrade-authority "$key" --program-id "$program" program-binary/copus_poe_solana.so
