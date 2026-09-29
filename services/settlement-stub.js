const http = require("http");
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { validToken } = require("./prover");

function createServer(token, db) {
  if (!token || token.length < 32) throw new Error("SETTLEMENT_TOKEN must be at least 32 characters");
  db.exec(`CREATE TABLE IF NOT EXISTS credits (event_key TEXT PRIMARY KEY, subject_ref TEXT NOT NULL,
    time_seconds INTEGER NOT NULL);`);
  return http.createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method !== "POST" || !validToken(request.headers.authorization, token)) {
      response.statusCode = 404; return response.end('{"error":"not found"}');
    }
    try {
      let body = "";
      for await (const chunk of request) {
        body += chunk;
        if (body.length > 10_000) throw new Error("request too large");
      }
      const payload = JSON.parse(body);
      const eventKey = request.headers["idempotency-key"];
      if (!eventKey || eventKey !== payload.idempotencyKey || payload.chain !== "solana-devnet"
          || !payload.subjectRef || !Number.isSafeInteger(payload.timeSeconds)
          || payload.timeSeconds <= 0 || payload.timeSeconds > 366 * 86_400) throw new Error("invalid settlement");
      const result = db.prepare("INSERT OR IGNORE INTO credits VALUES (?,?,?)")
        .run(eventKey, payload.subjectRef, payload.timeSeconds);
      response.end(JSON.stringify({ ok: true, duplicate: result.changes === 0 }));
    } catch (error) {
      response.statusCode = 400;
      response.end(JSON.stringify({ error: error.message }));
    }
  });
}

if (require.main === module) {
  const file = process.env.LEDGER_DB || path.join(process.cwd(), "poe-solana-demo-ledger.db");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) fs.closeSync(fs.openSync(file, "wx", 0o600));
  const db = new DatabaseSync(file);
  createServer(process.env.SETTLEMENT_TOKEN, db).listen(Number(process.env.SETTLEMENT_PORT || 8791), "127.0.0.1");
}

module.exports = { createServer };
