const snarkjs = require("snarkjs");
const path = require("path");
const { buildBatchV2, buildWitnessV2 } = require("../lib/poe-v2");

const BASE_FIELD = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
const byte32 = (value) => Buffer.from(BigInt(value).toString(16).padStart(64, "0"), "hex");

// groth16-solana uses big-endian BN254 coordinates and a negated A point.
function solanaProofBytes(proof) {
  const a = Buffer.concat([byte32(proof.pi_a[0]), byte32((BASE_FIELD - BigInt(proof.pi_a[1])) % BASE_FIELD)]);
  const b = Buffer.concat([
    byte32(proof.pi_b[0][1]), byte32(proof.pi_b[0][0]),
    byte32(proof.pi_b[1][1]), byte32(proof.pi_b[1][0]),
  ]);
  const c = Buffer.concat([byte32(proof.pi_c[0]), byte32(proof.pi_c[1])]);
  return Buffer.concat([a, b, c]);
}

async function prove({ receipts, policy, index, campaignId, epoch }) {
  const batch = await buildBatchV2(receipts, policy);
  const witness = await buildWitnessV2(receipts[index], policy, campaignId, batch.root, batch.proof(index), epoch);
  const artifacts = path.join(__dirname, "..", "zk-v2-artifacts");
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(witness,
    path.join(artifacts, "poe-v2.wasm"), path.join(artifacts, "poe-v2_final.zkey"));
  if (!await snarkjs.groth16.verify(require(path.join(artifacts, "verification_key.json")), publicSignals, proof)) {
    throw new Error("local Groth16 proof verification failed");
  }
  const expected = [batch.root, batch.ruleHash, witness.nullifier, BigInt(campaignId), BigInt(epoch)];
  if (publicSignals.some((value, i) => BigInt(value) !== expected[i])) throw new Error("public signals mismatch");
  return { root: byte32(batch.root), ruleHash: byte32(batch.ruleHash), nullifier: byte32(witness.nullifier),
    proof: solanaProofBytes(proof), publicSignals: expected.map(byte32) };
}

module.exports = { byte32, solanaProofBytes, prove };
