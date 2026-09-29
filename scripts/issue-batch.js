const fs = require("fs");
const path = require("path");
const { Connection, PublicKey, Transaction, sendAndConfirmTransaction } = require("@solana/web3.js");
const { normalizeEntries } = require("../lib/batch-entries");
const { buildBatchV2 } = require("../lib/poe-v2");
const { jsonFields } = require("../lib/poe");
const { loadKey, encryptJson } = require("../lib/batch-crypto");
const { byte32 } = require("./proof");
const client = require("./client");

async function issue({ connection, programId, issuer, policy, rows, key, archivePath,
  send = sendAndConfirmTransaction }) {
  if (fs.existsSync(archivePath)) throw new Error("batch archive already exists");
  fs.accessSync(path.dirname(archivePath), fs.constants.W_OK);
  const entries = normalizeEntries(rows);
  if (!entries.length || entries.some((entry) => !entry.subjectRef)) {
    throw new Error("each receipt must have a subjectRef");
  }
  const batch = await buildBatchV2(entries.map((entry) => entry.receipt), policy);
  const config = client.readConfig((await connection.getAccountInfo(client.configPda(programId))).data);
  if (!config.issuer.equals(issuer.publicKey)) throw new Error("wallet is not the authorized issuer");
  const batchId = config.nextBatchId;
  const tx = new Transaction().add(client.commitEvidence(programId, issuer.publicKey, batchId,
    byte32(batch.root), byte32(batch.ruleHash)));
  const signature = await send(connection, tx, [issuer], { commitment: "confirmed" });
  const chainBatch = await connection.getAccountInfo(client.batchPda(programId, batchId), "confirmed");
  if (!chainBatch?.owner.equals(programId) || chainBatch.data.length < 104
      || !chainBatch.data.subarray(40, 72).equals(byte32(batch.root))
      || !chainBatch.data.subarray(72, 104).equals(byte32(batch.ruleHash))) {
    throw new Error("committed batch does not match local evidence");
  }
  const archive = { batchId: batchId.toString(), root: batch.root.toString(),
    ruleHash: batch.ruleHash.toString(), policy, signature,
    entries: entries.map((entry, index) => ({ subjectRef: entry.subjectRef,
      receipt: entry.receipt, leafIndex: index, merkleProof: jsonFields(batch.proof(index)) })) };
  fs.writeFileSync(archivePath, JSON.stringify(encryptJson(archive, key)) + "\n", { flag: "wx", mode: 0o600 });
  return { batchId: batchId.toString(), root: byte32(batch.root).toString("hex"),
    ruleHash: byte32(batch.ruleHash).toString("hex"), signature, size: entries.length };
}

async function main() {
  for (const name of ["POE_PROGRAM_ID", "SOLANA_KEYPAIR_PATH", "POLICY_PATH", "RECEIPTS_PATH",
    "BATCH_ARCHIVE_PATH", "BATCH_ENCRYPTION_KEY"]) {
    if (!process.env[name]) throw new Error(`${name} is required`);
  }
  const rpc = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
  if (!rpc.includes("devnet")) throw new Error("issuer script runs on Devnet only");
  const policy = JSON.parse(fs.readFileSync(process.env.POLICY_PATH, "utf8"));
  const rows = JSON.parse(fs.readFileSync(process.env.RECEIPTS_PATH, "utf8"));
  const result = await issue({ connection: new Connection(rpc, "confirmed"),
    programId: new PublicKey(process.env.POE_PROGRAM_ID),
    issuer: client.readKeypair(process.env.SOLANA_KEYPAIR_PATH), policy, rows,
    key: loadKey(process.env.BATCH_ENCRYPTION_KEY), archivePath: process.env.BATCH_ARCHIVE_PATH });
  console.log(JSON.stringify(result));
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { issue };
