const http = require("http");
const { timingSafeEqual } = require("crypto");
const path = require("path");
const snarkjs = require("snarkjs");
const { buildWitnessV2 } = require("../lib/poe-v2");
const { solanaProofBytes, byte32 } = require("../scripts/proof");

const artifacts = path.join(__dirname, "..", "zk-v2-artifacts");
const key = require(path.join(artifacts, "verification_key.json"));

async function prove(input) {
  const witness = await buildWitnessV2(input.receipt, input.policy, input.campaignId,
    input.root, input.merkleProof, input.epoch);
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(witness,
    path.join(artifacts, "poe-v2.wasm"), path.join(artifacts, "poe-v2_final.zkey"));
  if (!await snarkjs.groth16.verify(key, publicSignals, proof)) throw new Error("proof verification failed");
  const expected = [witness.evidenceRoot, witness.ruleHash, witness.nullifier,
    witness.campaignId, witness.epoch];
  if (publicSignals.some((value, i) => BigInt(value) !== expected[i])) throw new Error("public signal mismatch");
  return { proof: solanaProofBytes(proof).toString("hex"),
    root: byte32(witness.evidenceRoot).toString("hex"),
    ruleHash: byte32(witness.ruleHash).toString("hex"),
    nullifier: byte32(witness.nullifier).toString("hex"),
    campaignId: witness.campaignId.toString(), epoch: witness.epoch.toString() };
}

function validToken(header, token) {
  if (!token || typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const received = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

function createServer(token) {
  if (!token || token.length < 32) throw new Error("PROVER_TOKEN must be at least 32 characters");
  return http.createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method !== "POST" || request.url !== "/prove" || !validToken(request.headers.authorization, token)) {
      response.statusCode = 404; return response.end('{"error":"not found"}');
    }
    let body = "";
    try {
      for await (const chunk of request) {
        body += chunk;
        if (body.length > 100_000) throw new Error("request too large");
      }
      const result = await prove(JSON.parse(body));
      response.end(JSON.stringify(result));
    } catch (error) {
      response.statusCode = 400;
      response.end(JSON.stringify({ error: error.message }));
    }
  });
}

if (require.main === module) {
  const server = createServer(process.env.PROVER_TOKEN);
  server.listen(Number(process.env.PROVER_PORT || 8790), process.env.BIND_HOST || "127.0.0.1");
}

module.exports = { prove, createServer, validToken };
