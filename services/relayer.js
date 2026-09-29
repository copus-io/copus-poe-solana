const http = require("http");
const path = require("path");
const { Connection, PublicKey, Transaction, sendAndConfirmTransaction } = require("@solana/web3.js");
const { validToken } = require("./prover");
const { Store } = require("./indexer");
const client = require("../scripts/client");

function decimal(value, name) {
  if (!/^(0|[1-9][0-9]*)$/.test(String(value))) throw new Error(`${name} must be a decimal integer`);
  return BigInt(value);
}

function bytes(value, length, name) {
  if (typeof value !== "string" || !new RegExp(`^[0-9a-fA-F]{${length * 2}}$`).test(value)) {
    throw new Error(`${name} must be ${length} bytes of hex`);
  }
  return Buffer.from(value, "hex");
}

function createHandler({ connection, programId, payer, token, store, send = sendAndConfirmTransaction,
  maxClaimsPerHour = 60, now = Date.now }) {
  if (!token || token.length < 32) throw new Error("RELAYER_TOKEN must be at least 32 characters");
  if (!Number.isInteger(maxClaimsPerHour) || maxClaimsPerHour < 1) throw new Error("invalid hourly limit");
  const sent = [];
  return async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method !== "POST" || request.url !== "/claims" || !validToken(request.headers.authorization, token)) {
      response.statusCode = 404; return response.end('{"error":"not found"}');
    }
    try {
      let body = "";
      for await (const chunk of request) {
        body += chunk;
        if (body.length > 100_000) throw new Error("request too large");
      }
      const input = JSON.parse(body);
      const campaignId = decimal(input.campaignId, "campaignId");
      const batchId = decimal(input.batchId, "batchId");
      const epoch = decimal(input.epoch, "epoch");
      const nullifier = bytes(input.nullifier, 32, "nullifier");
      const proof = bytes(input.proof, 256, "proof");
      const subjectRef = String(input.subjectRef || "");
      if (!subjectRef || subjectRef.length > 256) throw new Error("subjectRef is required");
      const claimAccount = client.claimPda(programId, campaignId, nullifier);
      if (await connection.getAccountInfo(claimAccount, "confirmed")) {
        response.statusCode = 409; return response.end('{"error":"already claimed"}');
      }
      while (sent.length && sent[0] <= now() - 3_600_000) sent.shift();
      if (sent.length >= maxClaimsPerHour) {
        response.statusCode = 429; return response.end('{"error":"hourly relay limit reached"}');
      }
      store.register(campaignId, nullifier.toString("hex"), subjectRef);
      const instruction = client.claim(programId, payer.publicKey, campaignId, batchId, nullifier, epoch, proof);
      sent.push(now());
      const signature = await send(connection, new Transaction().add(instruction), [payer],
        { commitment: "confirmed", maxRetries: 5 });
      response.statusCode = 202;
      response.end(JSON.stringify({ signature, claimAccount: claimAccount.toBase58() }));
    } catch (error) {
      response.statusCode = 400;
      response.end(JSON.stringify({ error: error.message }));
    }
  };
}

function main() {
  for (const name of ["POE_PROGRAM_ID", "SOLANA_KEYPAIR_PATH", "RELAYER_TOKEN"]) {
    if (!process.env[name]) throw new Error(`${name} is required`);
  }
  const rpc = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
  if (!rpc.includes("devnet")) throw new Error("relayer runs on Devnet only");
  const store = new Store(process.env.INDEXER_DB || path.join(process.cwd(), "poe-solana-indexer.db"));
  const handler = createHandler({ connection: new Connection(rpc, "confirmed"),
    programId: new PublicKey(process.env.POE_PROGRAM_ID),
    payer: client.readKeypair(process.env.SOLANA_KEYPAIR_PATH), token: process.env.RELAYER_TOKEN, store,
    maxClaimsPerHour: Number(process.env.RELAYER_MAX_CLAIMS_PER_HOUR || 60) });
  http.createServer(handler).listen(Number(process.env.RELAYER_PORT || 8788), process.env.BIND_HOST || "127.0.0.1");
}

if (require.main === module) { try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; } }
module.exports = { createHandler };
