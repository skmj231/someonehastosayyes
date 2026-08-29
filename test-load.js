const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PORT = 4398;
const BASE = `http://127.0.0.1:${PORT}`;
const BATCH = Number(process.env.LOAD_BATCH || 500);
const KEY_COUNT = Number(process.env.LOAD_KEYS || 1);
const KEYS = Array.from({ length: KEY_COUNT }, (_, i) => `load-test-key-${i}`);

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
}

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("test server did not start");
}

async function timedFetch(url, options) {
  const started = performance.now();
  const response = await fetch(url, options);
  const body = await response.json();
  return { response, body, ms: performance.now() - started };
}

async function main() {
  process.stderr.write("load test: starting\n");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shsy-load-"));
  const dbPath = path.join(tmp, "load.db");
  const server = spawn(process.execPath, ["server.js"], {
    cwd: __dirname,
    env: {
      ...process.env,
      PORT: String(PORT),
      BASE_URL: BASE,
      API_KEYS: KEYS.join(","),
      DB_PATH: dbPath,
      NODE_ENV: "test",
      TIMEOUT_SWEEP_MS: "60000",
      DELIVERY_SWEEP_MS: "60000",
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  let report;

  try {
    await waitForServer();
    process.stderr.write("load test: server ready\n");
    const headersFor = (i) => ({ authorization: `Bearer ${KEYS[i % KEYS.length]}`, "content-type": "application/json" });

    const created = await Promise.all(Array.from({ length: BATCH }, (_, i) =>
      timedFetch(`${BASE}/v1/approvals`, {
        method: "POST",
        headers: { ...headersFor(i), "idempotency-key": `load-${i}` },
        body: JSON.stringify({ question: `Load test ${i}`, channel: "link", timeout_minutes: 60 }),
      })
    ));
    assert.equal(created.filter((x) => x.response.status === 201).length, BATCH, "every create must succeed");
    assert.equal(new Set(created.map((x) => x.body.id)).size, BATCH, "every create must have a unique id");

    const read = await Promise.all(created.map((x, i) => timedFetch(`${BASE}/v1/approvals/${x.body.id}`, { headers: headersFor(i) })));
    assert.equal(read.filter((x) => x.response.status === 200 && x.body.status === "pending").length, BATCH, "every created approval must be readable");

    const idemKey = `same-${Date.now()}`;
    const duplicate = await Promise.all(Array.from({ length: 50 }, () =>
      timedFetch(`${BASE}/v1/approvals`, {
        method: "POST",
        headers: { ...headersFor(0), "idempotency-key": idemKey },
        body: JSON.stringify({ question: "One logical approval", channel: "link" }),
      })
    ));
    assert.equal(new Set(duplicate.map((x) => x.body.id)).size, 1, "concurrent idempotent creates must return one approval");
    assert.equal(duplicate.filter((x) => [200, 201].includes(x.response.status)).length, 50);

    const usedOnFirstKey = Math.ceil(BATCH / KEY_COUNT) + 1;
    const rateProbeCount = Math.max(0, 620 - usedOnFirstKey);
    const rateProbe = await Promise.all(Array.from({ length: rateProbeCount }, (_, i) =>
      timedFetch(`${BASE}/v1/approvals`, {
        method: "POST",
        headers: { ...headersFor(0), "idempotency-key": `rate-probe-${i}` },
        body: JSON.stringify({ question: `Rate protection ${i}`, channel: "link" }),
      })
    ));
    const expectedAccepted = Math.max(0, 600 - usedOnFirstKey);
    assert.equal(rateProbe.filter((x) => x.response.status === 201).length, expectedAccepted, "requests within the documented limit must succeed");
    assert.equal(rateProbe.filter((x) => x.response.status === 429).length, rateProbeCount - expectedAccepted, "excess requests must be rejected with 429");

    const createMs = created.map((x) => x.ms);
    const readMs = read.map((x) => x.ms);
    report = {
      batch: BATCH,
      api_keys: KEY_COUNT,
      creates: { ok: BATCH, p50_ms: Math.round(percentile(createMs, 0.5)), p95_ms: Math.round(percentile(createMs, 0.95)), max_ms: Math.round(Math.max(...createMs)) },
      reads: { ok: BATCH, p50_ms: Math.round(percentile(readMs, 0.5)), p95_ms: Math.round(percentile(readMs, 0.95)), max_ms: Math.round(Math.max(...readMs)) },
      idempotency_race: { requests: 50, unique_approvals: 1 },
      rate_protection: { accepted: expectedAccepted, rejected_429: rateProbeCount - expectedAccepted },
    };
    process.stderr.write("load test: measurements complete\n");
  } finally {
    process.stderr.write("load test: stopping server\n");
    if (server.exitCode == null && server.signalCode == null) {
      const exited = new Promise((resolve) => server.once("exit", resolve));
      server.kill("SIGTERM");
      await exited;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
