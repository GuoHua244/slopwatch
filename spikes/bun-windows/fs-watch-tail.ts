/**
 * Spike: does watch fire on appends on Bun/Windows — the JSONL-tail path the
 * Listener depends on? Appends 3 lines to a temp file, expects a watch event
 * per append, and reconstructs the appended bytes from the last known size.
 */
import {
  watch,
  statSync,
  openSync,
  readSync,
  closeSync,
  appendFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const file = join(tmpdir(), `slopwatch-spike-${process.pid}.jsonl`);
writeFileSync(file, '{"line":0}\n');

let size = statSync(file).size;
const events: { type: string; at: number }[] = [];
const watcher = watch(file, (event) => {
  events.push({ type: event, at: Date.now() });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const tail = (): string => {
  const now = statSync(file).size;
  if (now <= size) return "";
  const fd = openSync(file, "r");
  const buf = Buffer.alloc(now - size);
  readSync(fd, buf, 0, buf.length, size);
  closeSync(fd);
  size = now;
  return buf.toString("utf8");
};

const appended: string[] = [];
const appendAt: number[] = [];
for (let i = 1; i <= 3; i++) {
  await sleep(300);
  appendAt.push(Date.now());
  appendFileSync(file, `{"line":${i}}\n`);
  appended.push(`{"line":${i}}`);
}
await sleep(800);
watcher.close();

const received = tail();
const expected = appended.map((l) => `${l}\n`).join("");
const ok = received === expected && events.length >= 3;
const latencies = appendAt.map((t) => {
  const first = events.find((e) => e.at >= t);
  return first ? first.at - t : -1;
});
console.log(
  `SPIKE fs-watch-tail: ${ok ? "PASS" : "FAIL"} — ${events.length}/3 appends produced watch events; tail ${received === expected ? "reconstructed correctly" : `MISMATCH (${JSON.stringify(received)})`}; event latencies ms=[${latencies}]`,
);
if (!ok) console.log("  raw events:", JSON.stringify(events));
