const fs = require("fs");
const path = require("path");
const { Connection, PublicKey, Transaction, sendAndConfirmTransaction } = require("@solana/web3.js");
const { createMint, getOrCreateAssociatedTokenAccount, mintTo, getAccount } = require("@solana/spl-token");
const client = require("./client");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "test", "proof-fixture.json"), "utf8"));
const field = (name) => Buffer.from(fixture[name], "hex");

async function send(connection, payer, instruction) {
  return sendAndConfirmTransaction(connection, new Transaction().add(instruction), [payer],
    { commitment: "confirmed", maxRetries: 5 });
}

async function main() {
  const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
  if (!rpcUrl.includes("devnet")) throw new Error("demo only runs on Solana Devnet");
  if (!process.env.SOLANA_KEYPAIR_PATH || !process.env.POE_PROGRAM_ID || !process.env.POE_TREASURY_ADDRESS) {
    throw new Error("SOLANA_KEYPAIR_PATH, POE_PROGRAM_ID and POE_TREASURY_ADDRESS are required");
  }
  const connection = new Connection(rpcUrl, "confirmed");
  const payer = client.readKeypair(process.env.SOLANA_KEYPAIR_PATH);
  const programId = new PublicKey(process.env.POE_PROGRAM_ID);
  const treasury = new PublicKey(process.env.POE_TREASURY_ADDRESS);
  if (treasury.equals(payer.publicKey)) throw new Error("treasury must differ from advertiser");
  const program = await connection.getAccountInfo(programId);
  if (!program?.executable) throw new Error("program is not deployed on Devnet");
  if (await connection.getAccountInfo(client.configPda(programId))) {
    throw new Error("demo requires a fresh program with no config account");
  }
  const mint = await createMint(connection, payer, payer.publicKey, null, 6);
  const from = await getOrCreateAssociatedTokenAccount(connection, payer, mint, payer.publicKey);
  const to = await getOrCreateAssociatedTokenAccount(connection, payer, mint, treasury);
  await mintTo(connection, payer, mint, from.address, payer, 1_000_000);
  const initTx = await send(connection, payer,
    client.initialize(programId, payer.publicKey, payer.publicKey, treasury, mint));
  const config = client.readConfig((await connection.getAccountInfo(client.configPda(programId))).data);
  if (config.nextCampaignId !== 1n || config.nextBatchId !== 1n) throw new Error("unexpected config counters");
  const batchTx = await send(connection, payer,
    client.commitEvidence(programId, payer.publicKey, 1, field("root"), field("ruleHash")));
  const start = Math.floor(Date.now() / 1000) + 30;
  const fundTx = await send(connection, payer,
    client.fundAndActivate(programId, payer.publicKey, 1, from.address, to.address, mint, {
      paymentAmount: 1_000_000, manifestHash: Buffer.alloc(32, 1), ruleHash: field("ruleHash"),
      snapshotRoot: Buffer.alloc(32), mode: 0, startsAt: start, endsAt: 0,
      totalTimeMinutes: 30, timePerClaimMinutes: 30, claimPeriodSeconds: 0,
    }));
  while (Date.now() / 1000 < start + 2) await sleep(1_000);
  const claimTx = await send(connection, payer,
    client.claim(programId, payer.publicKey, 1, 1, field("nullifier"), 0, field("proof")));
  const receipt = await connection.getAccountInfo(client.claimPda(programId, 1, field("nullifier")));
  const treasuryToken = await getAccount(connection, to.address);
  if (!receipt || treasuryToken.amount !== 1_000_000n) throw new Error("funding or claim verification failed");
  console.log(JSON.stringify({ programId: programId.toBase58(), mint: mint.toBase58(),
    campaignId: 1, batchId: 1, initTx, batchTx, fundTx, claimTx,
    treasuryTokenBalance: treasuryToken.amount.toString() }, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
