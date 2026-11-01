/**
 * CW-RUST-M02 AT-M02-10 load generator, run as a SEPARATE process from the server under test so client work does not
 * share the server's event loop. Fires N concurrent GETs and prints one JSON line: p50/p99 latency and how many
 * responses differed from the expected answer.
 *
 *   bun run verification/src/m02-load.ts <base-url> <n> <expected.json>
 *
 * expected.json: [{ "headers": {...}, "expect": "<status>:<normalised body>" }, ...] — request i uses entry i % length.
 */
import { readFileSync } from "node:fs";

const [base, nRaw, expectedFile] = process.argv.slice(2);
if (!base || !nRaw || !expectedFile) throw Error("usage: m02-load.ts <base-url> <n> <expected.json>");
const n = Number(nRaw);
const cases: { headers: Record<string, string>; expect: string }[] = JSON.parse(readFileSync(expectedFile, "utf8"));
const PATH = "/api/v1/me/permissions";

function normalisedBody(body: string) {
  try {
    const j = JSON.parse(body);
    if (j && Array.isArray(j.permissions)) return JSON.stringify({ ...j, permissions: [...j.permissions].sort() });
    return JSON.stringify(j);
  } catch {
    return body;
  }
}
const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] as number;
};

let wrong = 0;
const times = await Promise.all(
  Array.from({ length: n }, async (_, i) => {
    const c = cases[i % cases.length] as (typeof cases)[number];
    const t = performance.now();
    const r = await fetch(`${base}${PATH}`, { headers: c.headers });
    const body = await r.text();
    const took = performance.now() - t;
    if (`${r.status}:${normalisedBody(body)}` !== c.expect) wrong++;
    return took;
  }),
);
console.log(JSON.stringify({ n, p50: pct(times, 50), p99: pct(times, 99), wrong, times }));
