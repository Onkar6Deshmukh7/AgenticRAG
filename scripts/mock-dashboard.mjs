// Mock metrics dashboard for end-to-end testing of the RCA tool.
//
// Mirrors the REAL hosted dashboard's response shape (shape 1) so the tool's
// window-parsing + fresh-data gating are exercised exactly as in production:
//   GET  /api/metrics/live     -> { current_period, is_running, seconds_per_period, window: [{period,timestamp,values,anomaly_flags}] }
//   GET  /api/metrics/initial  -> { values: {...baseline} }
//   POST /set?metric=<k>&value=<v>  -> override one metric for future periods
//   POST /api/simulate/start | /api/simulate/stop  -> toggle is_running
//
// A new period is appended on a timer (PERIOD_MS) while running, keeping a
// rolling window of the last WINDOW_SIZE periods — just like the real sim.
import http from "node:http";
import { URL } from "node:url";

const PERIOD_MS = Number(process.env.MOCK_PERIOD_MS ?? 2000); // fast for testing
const WINDOW_SIZE = 10;

// Baseline values (returned by /api/metrics/initial and used as the seed).
const baseline = {
  mapc: 130_000_000,
  total_trips: 2_700_000_000,
  gross_bookings: 37_000_000_000,
  take_rate: 27.5,
  adj_ebitda: 1_800_000_000,
  eta: 4.2,
  request_completion_rate: 92.3,
  acceptance_rate: 81.5,
  driver_utilization: 66,
  coverage: 97,
};

// `current` holds the values used to build the next period. `/set` mutates it.
const current = { ...baseline };
let period = -1;
let isRunning = true;
const window = [];

function appendPeriod() {
  if (!isRunning) return;
  period++;
  window.push({
    period,
    timestamp: new Date().toISOString(),
    values: { ...current },
    anomaly_flags: {},
  });
  while (window.length > WINDOW_SIZE) window.shift();
}

// Seed the very first period immediately so the window isn't empty on boot.
appendPeriod();
setInterval(appendPeriod, PERIOD_MS);

function json(res, code, body) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/api/metrics/live") {
    json(res, 200, {
      current_period: period,
      is_running: isRunning,
      seconds_per_period: PERIOD_MS / 1000,
      window,
    });
  } else if (url.pathname === "/api/metrics/initial") {
    json(res, 200, { values: baseline });
  } else if (url.pathname === "/set") {
    const metric = url.searchParams.get("metric");
    const value = Number(url.searchParams.get("value"));
    if (metric in current && Number.isFinite(value)) {
      current[metric] = value;
      console.log(`[mock] ${metric} set to ${value} (applies from next period)`);
      res.writeHead(200).end("ok");
    } else {
      res.writeHead(400).end("bad request");
    }
  } else if (url.pathname === "/api/simulate/start") {
    isRunning = true;
    console.log("[mock] simulation started");
    res.writeHead(200).end("ok");
  } else if (url.pathname === "/api/simulate/stop") {
    isRunning = false;
    console.log("[mock] simulation stopped");
    res.writeHead(200).end("ok");
  } else {
    res.writeHead(404).end("not found");
  }
}).listen(8000, () => console.log(`[mock] dashboard on http://localhost:8000 (period every ${PERIOD_MS}ms)`));
