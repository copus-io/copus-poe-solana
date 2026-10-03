const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const bs58 = require("bs58").default;
const { Keypair } = require("@solana/web3.js");
const client = require("../scripts/client");
const { Store, Indexer } = require("../services/indexer");

test("indexer waits for a subject mapping and credits one finalized claim once", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "poe-solana-indexer-"));
  const store = new Store(path.join(dir, "index.db"));
  try {
    const programId = Keypair.generate().publicKey;
    const payer = Keypair.generate().publicKey;
    const nullifier = Buffer.alloc(32, 7);
    const ruleHash = Buffer.alloc(32, 9);
    const ix = client.claim(programId, payer, 1, 2, nullifier, 0, Buffer.alloc(256));
    const parsed = { programId, accounts: ix.keys.map((k) => k.pubkey), data: bs58.encode(ix.data) };
    const campaign = Buffer.alloc(320);
    campaign.writeBigUInt64LE(1n, 0);
    campaign.writeUInt32LE(30, 64);
    ruleHash.copy(campaign, 73);
    const claim = Buffer.alloc(16);
    let calls = 0;
    const connection = {
      async getSignaturesForAddress() { return calls++ === 0 ? [{ signature: "sig1", err: null }] : []; },
      async getParsedTransaction() { return { meta: { err: null }, transaction: { message: { instructions: [parsed] } } }; },
      async getAccountInfo(pubkey) {
        if (pubkey.equals(client.campaignPda(programId, 1))) return { owner: programId, data: campaign };
        if (pubkey.equals(client.claimPda(programId, 1, nullifier))) return { owner: programId, data: claim };
        return null;
      },
    };
    const credits = [];
    const indexer = new Indexer({ connection, programId, store, settle: async (payload) => credits.push(payload) });
    assert.deepEqual(await indexer.tick(), { discovered: 1, completed: 0, pending: 1 });
    assert.equal(credits.length, 0);
    store.register(1, nullifier.toString("hex"), "copus-user:42");
    assert.deepEqual(await indexer.tick(), { discovered: 0, completed: 1, pending: 0 });
    assert.equal(credits.length, 1);
    assert.equal(credits[0].subjectRef, "copus-user:42");
    assert.equal(credits[0].timeSeconds, 1800);
    assert.equal(credits[0].ruleHash, ruleHash.toString("hex"));
    assert.deepEqual(await indexer.tick(), { discovered: 0, completed: 0, pending: 0 });
    assert.equal(credits.length, 1);
    assert.throws(() => store.register(1, nullifier.toString("hex"), "another-user"), /first-writer-wins/);
  } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});


test("missing mappings and poisoned signatures cannot starve later settlements", async () => {
  let now = 1000;
  const store = new Store(":memory:", {now: () => now});
  try {
    store.discover(Array.from({length:100}, (_,i) => `missing-${i}`));
    const connection = {getSignaturesForAddress:async()=>[], getParsedTransaction:async()=>null};
    const indexer = new Indexer({connection, programId:Keypair.generate().publicKey, store, settle:async()=>{}, maxAttempts:2});
    assert.equal((await indexer.tick()).pending,100);
    store.discover(["later-valid"]);
    connection.getParsedTransaction=async(signature)=> signature==="later-valid" ? {meta:{err:null},transaction:{message:{instructions:[]}}} : null;
    assert.equal((await indexer.tick()).completed,1);
    now+=10000;
    assert.equal((await indexer.tick()).pending,100);
    assert.equal(store.quarantined().length,100);
    store.retry("missing-0");
    assert.deepEqual(store.pendingSignatures(),["missing-0"]);
  } finally {store.close();}
});
