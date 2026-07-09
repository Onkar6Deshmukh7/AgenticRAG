// Mock metrics dashboard for end-to-end testing of the RCA tool.
// GET  /api/metrics/live          -> { period, values: {...} }
// POST /set?metric=<k>&value=<v>  -> override one metric's value
import http from "node:http";
import { URL } from "node:url";

let period = 0;
const values = {
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

http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/api/metrics/live") {
    period++;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ period, values }));
  } else if (url.pathname === "/set") {
    const metric = url.searchParams.get("metric");
    const value = Number(url.searchParams.get("value"));
    if (metric in values && Number.isFinite(value)) {
      values[metric] = value;
      console.log(`[mock] ${metric} set to ${value}`);
      res.writeHead(200).end("ok");
    } else {
      res.writeHead(400).end("bad request");
    }
  } else {
    res.writeHead(404).end("not found");
  }
}).listen(8000, () => console.log("[mock] dashboard on http://localhost:8000"));
