const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { Keypair, PublicKey } = require("@solana/web3.js");
const client = require("../scripts/client");

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "proof-fixture.json"), "utf8"));
const program = Keypair.generate().publicKey;
const owner = Keypair.generate().publicKey;
const mint = Keypair.generate().publicKey;
const field = (name) => Buffer.from(fixture[name], "hex");

test("client derives fixed PDAs and encodes proof bytes in the Rust instruction order", () => {
  assert.notEqual(client.campaignPda(program, 1).toBase58(), client.campaignPda(program, 2).toBase58());
  const ix = client.claim(program, owner, 1, 2, field("nullifier"), 0, field("proof"));
  assert.equal(ix.data.length, 305);
  assert.equal(ix.data[0], 3);
  assert.equal(ix.data.readBigUInt64LE(1), 2n);
  assert.deepEqual(ix.data.subarray(9, 41), field("nullifier"));
  assert.equal(ix.data.readBigUInt64LE(41), 0n);
  assert.deepEqual(ix.data.subarray(49), field("proof"));
  assert.equal(ix.keys[3].pubkey.toBase58(), client.claimPda(program, 1, field("nullifier")).toBase58());
});

test("client includes upgrade authority proof when initializing", () => {
  const ix = client.initialize(program, owner, owner, Keypair.generate().publicKey, mint);
  assert.equal(ix.data.length, 97);
  assert.equal(ix.keys.length, 4);
  assert.equal(ix.keys[2].isWritable, false);
  assert.equal(ix.keys[0].isSigner, true);
});

test("funding and config bytes match on-chain layouts", () => {
  const ix = client.fundAndActivate(program, owner, 1, owner, owner, mint, {
    paymentAmount: 42, manifestHash: Buffer.alloc(32, 1), ruleHash: field("ruleHash"),
    snapshotRoot: Buffer.alloc(32), mode: 0, startsAt: 1000, endsAt: 0,
    totalTimeMinutes: 60, timePerClaimMinutes: 30, claimPeriodSeconds: 0,
  });
  assert.equal(ix.data.length, 134);
  assert.equal(ix.data.readBigUInt64LE(1), 42n);
  const bytes = Buffer.alloc(256);
  owner.toBuffer().copy(bytes, 0);
  mint.toBuffer().copy(bytes, 96);
  bytes.writeBigUInt64LE(7n, 128);
  bytes.writeBigUInt64LE(9n, 136);
  const config = client.readConfig(bytes);
  assert.equal(config.nextCampaignId, 7n);
  assert.equal(config.nextBatchId, 9n);
  assert.ok(config.fundingMint.equals(new PublicKey(mint)));
});
