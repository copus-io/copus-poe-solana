const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Keypair } = require("@solana/web3.js");
const { decryptJson } = require("../lib/batch-crypto");
const { issue } = require("../scripts/issue-batch");
const client = require("../scripts/client");

test("issuer commits a v2 root and stores private receipt paths only as ciphertext", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "poe-solana-issue-"));
  try {
    const archivePath = path.join(dir, "batch-1.enc.json");
    const issuer = Keypair.generate();
    const programId = Keypair.generate().publicKey;
    const config = Buffer.alloc(256);
    issuer.publicKey.toBuffer().copy(config, 32);
    config.writeBigUInt64LE(1n, 136);
    let batch;
    const connection = { async getAccountInfo(pubkey) {
      if (pubkey.equals(client.configPda(programId))) return { owner: programId, data: config };
      if (pubkey.equals(client.batchPda(programId, 1))) return batch;
      return null;
    } };
    const send = async (_connection, tx) => {
      const data = tx.instructions[0].data;
      assert.equal(data[0], 1);
      const bytes = Buffer.alloc(128);
      bytes.writeBigUInt64LE(1n, 0);
      data.subarray(1, 33).copy(bytes, 40);
      data.subarray(33, 65).copy(bytes, 72);
      batch = { owner: programId, data: bytes };
      return "batch-signature";
    };
    const key = Buffer.alloc(32, 8);
    const policy = { minEvents: "3", minDwellSeconds: "90", notBefore: "1700000000",
      match: "ALL", rules: [{ type: "work_count", operator: 1, threshold: "1", target: "0" }] };
    const receipt = { subjectSecret: "912345", eventCount: "4", totalDwellSeconds: "145",
      observedAt: "1800000000", receiptNonce: "77", facts: ["1"] };
    const result = await issue({ connection, programId, issuer, policy,
      rows: [{ subjectRef: "demo-reader", receipt }], key, archivePath, send });
    assert.equal(result.batchId, "1");
    assert.equal(result.signature, "batch-signature");
    const ciphertext = fs.readFileSync(archivePath, "utf8");
    assert.ok(!ciphertext.includes("912345"));
    const archive = decryptJson(JSON.parse(ciphertext), key);
    assert.equal(archive.entries[0].receipt.subjectSecret, "912345");
    assert.equal(archive.entries[0].merkleProof.pathElements.length, 8);
    assert.equal(fs.statSync(archivePath).mode & 0o777, 0o600);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
