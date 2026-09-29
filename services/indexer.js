const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { Connection, PublicKey } = require("@solana/web3.js");
const bs58 = require("bs58").default;
const client = require("../scripts/client");

class Store {
  constructor(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) fs.closeSync(fs.openSync(file, "wx", 0o600));
    this.db = new DatabaseSync(file);
    this.db.exec(`CREATE TABLE IF NOT EXISTS metadata (name TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS subjects (campaign_id TEXT NOT NULL, nullifier TEXT NOT NULL,
        subject_ref TEXT NOT NULL, PRIMARY KEY(campaign_id, nullifier));
      CREATE TABLE IF NOT EXISTS signatures (signature TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'pending');
      CREATE TABLE IF NOT EXISTS settlements (event_key TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'pending');`);
  }
  cursor() { return this.db.prepare("SELECT value FROM metadata WHERE name='cursor'").get()?.value || null; }
  discover(signatures) {
    this.db.exec("BEGIN");
    try {
      const insert = this.db.prepare("INSERT OR IGNORE INTO signatures(signature) VALUES (?)");
      for (const signature of signatures) insert.run(signature);
      if (signatures.length) this.db.prepare("INSERT INTO metadata(name,value) VALUES ('cursor',?) ON CONFLICT(name) DO UPDATE SET value=excluded.value")
        .run(signatures[0]);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  register(campaignId, nullifier, subjectRef) {
    if (!/^[0-9]+$/.test(String(campaignId)) || !/^[0-9a-f]{64}$/.test(nullifier)
        || typeof subjectRef !== "string" || !subjectRef.trim()) throw new Error("invalid claim mapping");
    this.db.prepare("INSERT OR IGNORE INTO subjects VALUES (?,?,?)").run(String(campaignId), nullifier, subjectRef);
    const existing = this.subject(campaignId, nullifier);
    if (existing !== subjectRef) throw new Error("claim mapping is first-writer-wins");
  }
  subject(campaignId, nullifier) {
    return this.db.prepare("SELECT subject_ref FROM subjects WHERE campaign_id=? AND nullifier=?")
      .get(String(campaignId), nullifier)?.subject_ref || null;
  }
  pendingSignatures() { return this.db.prepare("SELECT signature FROM signatures WHERE status='pending' ORDER BY rowid LIMIT 100").all().map((r) => r.signature); }
  completed(eventKey) { return this.db.prepare("SELECT status FROM settlements WHERE event_key=?").get(eventKey)?.status === "complete"; }
  completeEvent(eventKey) { this.db.prepare("INSERT INTO settlements(event_key,status) VALUES (?,'complete') ON CONFLICT(event_key) DO UPDATE SET status='complete'").run(eventKey); }
  completeSignature(signature) { this.db.prepare("UPDATE signatures SET status='complete' WHERE signature=?").run(signature); }
  close() { this.db.close(); }
}

function parseClaim(ix, programId) {
  if (!ix.programId?.equals(programId) || typeof ix.data !== "string" || !Array.isArray(ix.accounts)) return null;
  const data = Buffer.from(bs58.decode(ix.data));
  if (data.length !== 305 || data[0] !== 3 || ix.accounts.length !== 5) return null;
  return { campaignAccount: ix.accounts[1], batchAccount: ix.accounts[2], claimAccount: ix.accounts[3],
    batchId: data.readBigUInt64LE(1), nullifier: data.subarray(9, 41), epoch: data.readBigUInt64LE(41) };
}

async function claimPayload(connection, programId, signature, index, parsed) {
  const campaignInfo = await connection.getAccountInfo(parsed.campaignAccount, "finalized");
  const claimInfo = await connection.getAccountInfo(parsed.claimAccount, "finalized");
  if (!campaignInfo?.owner.equals(programId) || !claimInfo?.owner.equals(programId)
      || campaignInfo.data.length < 105 || claimInfo.data.length < 8) throw new Error("claim account is missing");
  const campaignId = campaignInfo.data.readBigUInt64LE(0);
  const campaignPda = client.campaignPda(programId, campaignId);
  const expectedClaim = client.claimPda(programId, campaignId, parsed.nullifier);
  if (!campaignPda.equals(parsed.campaignAccount) || !expectedClaim.equals(parsed.claimAccount)
      || claimInfo.data.readBigUInt64LE(0) !== parsed.epoch) throw new Error("claim account mismatch");
  const mode = campaignInfo.data[72];
  if (mode === 0 && !client.batchPda(programId, parsed.batchId).equals(parsed.batchAccount)) {
    throw new Error("batch account mismatch");
  }
  const minutes = campaignInfo.data.readUInt32LE(64);
  if (!minutes || minutes > 525_600) throw new Error("invalid campaign claim duration");
  return { idempotencyKey: `solana-devnet:${signature}:${index}`, chain: "solana-devnet",
    transactionSignature: signature, instructionIndex: index, campaignId: campaignId.toString(),
    batchId: parsed.batchId.toString(), nullifier: parsed.nullifier.toString("hex"),
    ruleHash: campaignInfo.data.subarray(73, 105).toString("hex"), epoch: parsed.epoch.toString(),
    timeSeconds: minutes * 60 };
}

class Indexer {
  constructor({ connection, programId, store, settle }) { Object.assign(this, { connection, programId, store, settle }); }
  async discover() {
    const previous = this.store.cursor();
    let before;
    const signatures = [];
    for (let page = 0; page < 20; page++) {
      const rows = await this.connection.getSignaturesForAddress(this.programId,
        { limit: 1000, ...(before && { before }), ...(previous && { until: previous }) }, "finalized");
      signatures.push(...rows.map((r) => r.signature));
      if (rows.length < 1000) break;
      if (page === 19) throw new Error("signature backlog exceeds scan limit; cursor not advanced");
      before = rows[rows.length - 1].signature;
    }
    this.store.discover(signatures);
    return signatures.length;
  }
  async processSignature(signature) {
    const tx = await this.connection.getParsedTransaction(signature,
      { commitment: "finalized", maxSupportedTransactionVersion: 0 });
    if (!tx) return false;
    if (tx.meta?.err) { this.store.completeSignature(signature); return true; }
    const instructions = tx.transaction.message.instructions;
    for (let index = 0; index < instructions.length; index++) {
      const parsed = parseClaim(instructions[index], this.programId);
      if (!parsed) continue;
      const key = `solana-devnet:${signature}:${index}`;
      if (this.store.completed(key)) continue;
      const payload = await claimPayload(this.connection, this.programId, signature, index, parsed);
      const subjectRef = this.store.subject(payload.campaignId, payload.nullifier);
      if (!subjectRef) return false;
      await this.settle({ ...payload, subjectRef });
      this.store.completeEvent(key);
    }
    this.store.completeSignature(signature);
    return true;
  }
  async tick() {
    const discovered = await this.discover();
    let completed = 0;
    let pending = 0;
    for (const signature of this.store.pendingSignatures()) {
      try { if (await this.processSignature(signature)) completed++; else pending++; }
      catch (error) { pending++; console.error(`settlement ${signature}: ${error.message}`); }
    }
    return { discovered, completed, pending };
  }
}

async function postSettlement(url, token, payload) {
  const response = await fetch(url, { method: "POST", headers: {
    "content-type": "application/json", authorization: `Bearer ${token}`,
    "idempotency-key": payload.idempotencyKey }, body: JSON.stringify(payload), signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`settlement returned HTTP ${response.status}`);
}

async function main() {
  const file = process.env.INDEXER_DB || path.join(process.cwd(), "poe-solana-indexer.db");
  const store = new Store(file);
  if (process.argv[2] === "register") {
    const [, , , campaignId, nullifier, subjectRef] = process.argv;
    store.register(campaignId, nullifier, subjectRef);
    store.close();
    return;
  }
  if (!process.env.POE_PROGRAM_ID || !process.env.SETTLEMENT_URL || !process.env.SETTLEMENT_TOKEN) {
    throw new Error("POE_PROGRAM_ID, SETTLEMENT_URL and SETTLEMENT_TOKEN are required");
  }
  const rpc = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
  if (!rpc.includes("devnet")) throw new Error("this indexer is configured for Devnet only");
  const indexer = new Indexer({ connection: new Connection(rpc, "finalized"),
    programId: new PublicKey(process.env.POE_PROGRAM_ID), store,
    settle: (payload) => postSettlement(process.env.SETTLEMENT_URL, process.env.SETTLEMENT_TOKEN, payload) });
  for (;;) {
    console.log(JSON.stringify(await indexer.tick()));
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
}

if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { Store, Indexer, parseClaim, claimPayload, postSettlement };
