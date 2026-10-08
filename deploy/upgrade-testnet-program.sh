#!/usr/bin/env bash
# Upgrade only the checked-in, verified Devnet demo program; never mainnet.
set -euo pipefail
cd "$(dirname "$0")/.."
[[ -z "$(git status --porcelain)" ]] || { echo 'Clean committed source required'; exit 1; }
python3 - <<'VERIFY'
import json,hashlib
from pathlib import Path
manifest=json.loads(Path('program-binary/manifest.json').read_text())
assert hashlib.sha256(Path('program-binary/copus_poe_solana.so').read_bytes()).hexdigest()==manifest['sha256']
assert manifest['minimumClaimMinutes']==10
VERIFY
rpc=https://api.devnet.solana.com
key="${POE_DEMO_HOME:?Private runtime required}/secrets/operator.json"
[[ "$(solana genesis-hash --url "$rpc" --keypair "$key")" == EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG ]] || exit 1
program=8oUVMRStpkqaFCDSdqvP4fM7AEgv4CCEqJ4gu3jsoR65
operator=$(solana-keygen pubkey "$key")
solana program show "$program" --url "$rpc" --keypair "$key" --output json > /tmp/copus-poe-devnet-program-info.json
python3 - "$operator" <<'PY'
import json,sys
with open('/tmp/copus-poe-devnet-program-info.json') as f: v=json.load(f)
assert v.get('authority')==sys.argv[1], 'Operator must be the existing upgrade authority'
PY
extra=$(python3 - <<'SPACE'
import json
from pathlib import Path
info=json.loads(Path('/tmp/copus-poe-devnet-program-info.json').read_text())
delta=Path('program-binary/copus_poe_solana.so').stat().st_size-info['dataLen']
print(max(0,(delta+10239)//10240*10240))
SPACE
)
if (( extra > 0 )); then solana program extend "$program" "$extra" --url "$rpc" --keypair "$key"; fi
solana program deploy --url "$rpc" --keypair "$key" --upgrade-authority "$key" --program-id "$program" program-binary/copus_poe_solana.so
