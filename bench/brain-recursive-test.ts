#!/usr/bin/env npx tsx
/**
 * Brain vault: Flat vs Phase 1 vs Phase 3 Recursive — head to head.
 */
import { runQueryRanked } from "../src/cli/search.js";
import { runExplore } from "../src/cli/explore.js";

const VAULT = "C:/Users/aayoa/brain";

const QUERIES = [
  { q: "what connects crypto and CourtShare", type: "cross-domain" },
  { q: "how does token incentives relate to user engagement", type: "cross-domain" },
  { q: "what blocks CourtShare from being a business", type: "multi-hop" },
  { q: "how does spreading activation relate to personalized pagerank", type: "deep-recall" },
  { q: "what did we learn from the RLM paper and how does it connect to Ori", type: "multi-hop" },
  { q: "what is the relationship between vitality decay and bridge notes", type: "deep-recall" },
  { q: "how should the discord agent team use memory", type: "cross-domain" },
  { q: "what research informs the retrieval intelligence design", type: "multi-hop" },
  { q: "why is markdown on disk better than a database for agent memory", type: "deep-recall" },
  { q: "what is the connection between Kashi cryptocurrency and AI agents", type: "cross-domain" },
];

async function main() {
  console.log("Brain Vault: Flat vs Phase 1 vs Phase 3 Recursive");
  console.log("=".repeat(80) + "\n");

  const results: Array<{
    query: string; type: string;
    flatTitles: string[]; p1Titles: string[]; recTitles: string[];
    p1Only: string[]; recOnly: string[]; recVsP1Only: string[];
    flatMs: number; p1Ms: number; recMs: number;
  }> = [];

  for (const { q, type } of QUERIES) {
    process.stdout.write(`  [${type.padEnd(12)}] "${q.substring(0, 45)}..." `);

    const t1 = Date.now();
    const flat = await runQueryRanked(VAULT, q, 10, true);
    const flatMs = Date.now() - t1;
    const flatTitles = flat.data.results.map((r: any) => r.title);

    const t2 = Date.now();
    const p1 = await runExplore(VAULT, q, { limit: 10, recursive: false });
    const p1Ms = Date.now() - t2;
    const p1Titles = p1.data.results.map((r: any) => r.title);

    const t3 = Date.now();
    const rec = await runExplore(VAULT, q, { limit: 10, recursive: true });
    const recMs = Date.now() - t3;
    const recTitles = rec.data.results.map((r: any) => r.title);

    const flatSet = new Set(flatTitles);
    const p1Set = new Set(p1Titles);
    const recSet = new Set(recTitles);

    const p1Only = p1Titles.filter((t: string) => !flatSet.has(t));
    const recOnly = recTitles.filter((t: string) => !flatSet.has(t));
    const recVsP1Only = recTitles.filter((t: string) => !p1Set.has(t));

    results.push({ query: q, type, flatTitles, p1Titles, recTitles, p1Only, recOnly, recVsP1Only, flatMs, p1Ms, recMs });

    const recDepth = (rec.data as any).recursion_depth ?? 0;
    const recSubs = (rec.data as any).sub_queries?.length ?? 0;
    const converged = (rec.data as any).converged ?? false;
    console.log(`rec_depth=${recDepth} subs=${recSubs} conv=${converged} rec_vs_p1_new=${recVsP1Only.length}`);
  }

  // Detailed
  console.log("\n" + "=".repeat(80));
  console.log("  DETAILED: What Recursive Found That Phase 1 Missed");
  console.log("=".repeat(80));

  for (const r of results) {
    if (r.recVsP1Only.length === 0) continue;
    console.log(`\n  Query: "${r.query}"`);
    console.log(`  Type: ${r.type} | Recursive found ${r.recVsP1Only.length} notes Phase 1 missed:`);
    for (const t of r.recVsP1Only.slice(0, 5)) {
      console.log(`    + ${t.substring(0, 90)}`);
    }
  }

  // Summary
  const avgP1Only = results.reduce((s, r) => s + r.p1Only.length, 0) / results.length;
  const avgRecOnly = results.reduce((s, r) => s + r.recOnly.length, 0) / results.length;
  const avgRecVsP1 = results.reduce((s, r) => s + r.recVsP1Only.length, 0) / results.length;
  const avgFlatMs = results.reduce((s, r) => s + r.flatMs, 0) / results.length;
  const avgP1Ms = results.reduce((s, r) => s + r.p1Ms, 0) / results.length;
  const avgRecMs = results.reduce((s, r) => s + r.recMs, 0) / results.length;

  const p1VsFlat = results.reduce((s, r) => {
    const p1Set = new Set(r.p1Titles);
    const flatSet = new Set(r.flatTitles);
    return s + r.p1Titles.filter(t => !flatSet.has(t)).length + r.flatTitles.filter(t => !p1Set.has(t)).length;
  }, 0) / results.length / 2;

  console.log("\n" + "=".repeat(80));
  console.log("  SUMMARY");
  console.log("=".repeat(80));
  console.log(`  Phase 1 finds (flat misses):   ${avgP1Only.toFixed(1)} notes/query`);
  console.log(`  Recursive finds (flat misses): ${avgRecOnly.toFixed(1)} notes/query`);
  console.log(`  Recursive finds (P1 misses):   ${avgRecVsP1.toFixed(1)} notes/query  ← Phase 3 value`);
  console.log(`  Flat latency:      ${avgFlatMs.toFixed(0)}ms`);
  console.log(`  Phase 1 latency:   ${avgP1Ms.toFixed(0)}ms`);
  console.log(`  Recursive latency: ${avgRecMs.toFixed(0)}ms`);
  console.log("=".repeat(80));
}

main().catch(e => { console.error(e); process.exit(1); });
