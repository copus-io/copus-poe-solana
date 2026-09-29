const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { Keypair } = require("@solana/web3.js");
const { Store } = require("../services/indexer");
const { createHandler } = require("../services/relayer");

test("relayer authenticates and persists the subject mapping before broadcast", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "poe-solana-relayer-"));
  const store = new Store(path.join(dir, "index.db"));
  const token = "a".repeat(32);
  const nullifier = Buffer.alloc(32, 3).toString("hex");
  const proof = Buffer.alloc(256, 4).toString("hex");
  let broadcasts = 0;
  const handler = createHandler({ connection: { getAccountInfo: async () => null },
    programId: Keypair.generate().publicKey, payer: Keypair.generate(), token, store, maxClaimsPerHour: 1,
    send: async () => {
      assert.equal(store.subject(1, nullifier), "copus-user:42");
      broadcasts++;
      return "signature1";
    } });
  const server = http.createServer(handler).listen(0, "127.0.0.1");
  try {
    await new Promise((resolve) => server.once("listening", resolve));
    const url = `http://127.0.0.1:${server.address().port}/claims`;
    const body = JSON.stringify({ campaignId: "1", batchId: "1", epoch: "0", nullifier, proof,
      subjectRef: "copus-user:42" });
    const call = (credential, payload = body) => fetch(url, { method: "POST", headers: {
      authorization: `Bearer ${credential}`, "content-type": "application/json" }, body: payload });
    assert.equal((await call("wrong")).status, 404);
    assert.equal((await call(token, "{}" )).status, 400);
    const first = await call(token);
    assert.equal(first.status, 202);
    assert.equal((await first.json()).signature, "signature1");
    assert.equal((await call(token)).status, 429);
    assert.equal(broadcasts, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
