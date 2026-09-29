const fs = require("fs");
const path = require("path");
const { prove } = require("./proof");

const policy = {
  minEvents: "3", minDwellSeconds: "90", notBefore: "1700000000", match: "ALL",
  rules: [{ type: "work_count", operator: 1, threshold: "1", target: "0" }],
};
const receipt = { subjectSecret: "912345", eventCount: "4", totalDwellSeconds: "145",
  observedAt: "1800000000", receiptNonce: "77", facts: ["1"] };

async function main() {
  const result = await prove({ receipts: [receipt], policy, index: 0, campaignId: 1, epoch: 0 });
  const output = { root: result.root.toString("hex"), ruleHash: result.ruleHash.toString("hex"),
    nullifier: result.nullifier.toString("hex"), proof: result.proof.toString("hex"),
    publicSignals: result.publicSignals.map((v) => v.toString("hex")) };
  const target = path.join(__dirname, "..", "test", "proof-fixture.json");
  fs.writeFileSync(target, JSON.stringify(output, null, 2) + "\n");
  console.log(`Wrote public proof fixture to ${target}`);
  // snarkjs may leave a worker thread alive after the CLI has written its file.
  process.exit(0);
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
