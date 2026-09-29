const fs = require("fs");
const { PublicKey, Keypair, TransactionInstruction, SystemProgram } = require("@solana/web3.js");
const { TOKEN_PROGRAM_ID } = require("@solana/spl-token");
const BPF_LOADER_UPGRADEABLE_PROGRAM_ID = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const i64 = (n) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(Number(n)); return b; };
const key = (pubkey, isSigner = false, isWritable = false) => ({ pubkey, isSigner, isWritable });
const pda = (programId, seeds) => PublicKey.findProgramAddressSync(seeds, programId)[0];
const configPda = (programId) => pda(programId, [Buffer.from("config")]);
const campaignPda = (programId, id) => pda(programId, [Buffer.from("campaign"), u64(id)]);
const batchPda = (programId, id) => pda(programId, [Buffer.from("batch"), u64(id)]);
const claimPda = (programId, id, nullifier) => pda(programId, [Buffer.from("claim"), u64(id), nullifier]);
const instruction = (programId, keys, data) => new TransactionInstruction({ programId, keys, data: Buffer.concat(data) });

function initialize(programId, admin, issuer, treasury, mint) {
  const programData = pda(BPF_LOADER_UPGRADEABLE_PROGRAM_ID, [programId.toBuffer()]);
  return instruction(programId, [key(admin, true, true), key(configPda(programId), false, true),
    key(programData), key(SystemProgram.programId)], [Buffer.from([0]), issuer.toBuffer(), treasury.toBuffer(), mint.toBuffer()]);
}

function setIssuer(programId, admin, issuer) {
  return instruction(programId, [key(admin, true), key(configPda(programId), false, true)],
    [Buffer.from([4]), issuer.toBuffer()]);
}

function commitEvidence(programId, issuer, id, root, ruleHash) {
  return instruction(programId, [key(issuer, true, true), key(configPda(programId), false, true),
    key(batchPda(programId, id), false, true), key(SystemProgram.programId)],
  [Buffer.from([1]), root, ruleHash]);
}

function fundAndActivate(programId, advertiser, id, from, to, mint, data) {
  return instruction(programId, [key(advertiser, true, true), key(configPda(programId), false, true),
    key(campaignPda(programId, id), false, true), key(from, false, true), key(to, false, true),
    key(mint), key(TOKEN_PROGRAM_ID), key(SystemProgram.programId)], [
      Buffer.from([2]), u64(data.paymentAmount), data.manifestHash, data.ruleHash, data.snapshotRoot,
      Buffer.from([data.mode]), i64(data.startsAt), i64(data.endsAt), u32(data.totalTimeMinutes),
      u32(data.timePerClaimMinutes), u32(data.claimPeriodSeconds),
    ]);
}

function claim(programId, payer, campaignId, batchId, nullifier, epoch, proof) {
  if (proof.length !== 256) throw new Error("proof must be 256 bytes");
  return instruction(programId, [key(payer, true, true), key(campaignPda(programId, campaignId), false, true),
    key(batchPda(programId, batchId)), key(claimPda(programId, campaignId, nullifier), false, true),
    key(SystemProgram.programId)], [Buffer.from([3]), u64(batchId), nullifier, u64(epoch), proof]);
}

function readConfig(data) {
  if (!data || data.length < 144) throw new Error("invalid config account");
  return {
    admin: new PublicKey(data.subarray(0, 32)), issuer: new PublicKey(data.subarray(32, 64)),
    treasury: new PublicKey(data.subarray(64, 96)), fundingMint: new PublicKey(data.subarray(96, 128)),
    nextCampaignId: data.readBigUInt64LE(128), nextBatchId: data.readBigUInt64LE(136),
  };
}

function readKeypair(file) {
  const bytes = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(bytes) || bytes.length !== 64) throw new Error("expected a 64-byte Solana keypair file");
  return Keypair.fromSecretKey(Uint8Array.from(bytes));
}

module.exports = { initialize, setIssuer, commitEvidence, fundAndActivate, claim, readConfig, readKeypair,
  configPda, campaignPda, batchPda, claimPda, u64 };
