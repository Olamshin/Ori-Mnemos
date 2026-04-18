#!/usr/bin/env npx tsx
/**
 * Compare ori_query_ranked vs ori_explore on the real brain vault.
 * Tests cross-domain, multi-hop, and deep recall queries.
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
  console.log("Brain Vault: ori_query_ranked vs ori_explore");
  console.log("=".repeat(80) + "\n");

  const results: Array<{
    query: string;
    type: string;
    flatTitles: string[];
    exploreTitles: string[];
    flatOnly: string[];
    exploreOnly: string[];
    overlap: string[];
    flatMs: number;
    exploreMs: number;
  }> = [];

  for (const { q, type } of QUERIES) {
    process.stdout.write(`  [${type}] "${q.substring(0, 50)}..." `);

    const t1 = Date.now();
    const flat = await runQueryRanked(VAULT, q, 10, true);
    const flatMs = Date.now() - t1;
    const flatTitles = flat.data.results.map((r: any) => r.title);

    const t2 = Date.now();
    const exp = await runExplore(VAULT, q, { limit: 10 });
    const exploreMs = Date.now() - t2;
    const exploreTitles = exp.data.results.map((r: any) => r.title);

    const flatSet = new Set(flatTitles);
    const expSet = new Set(exploreTitles);
    const overlap = flatTitles.filter((t: string) => expSet.has(t));
    const flatOnly = flatTitles.filter((t: string) => !expSet.has(t));
    const exploreOnly = exploreTitles.filter((t: string) => !flatSet.has(t));

    results.push({ query: q, type, flatTitles, exploreTitles, flatOnly, exploreOnly, overlap, flatMs, exploreMs });
    console.log(`overlap=${overlap.length}/10  flat=${flatMs}ms  explore=${exploreMs}ms`);
  }

  // Detailed report
  console.log("\n" + "=".repeat(80));
  console.log("  DETAILED RESULTS");
  console.log("=".repeat(80));

  for (const r of results) {
    console.log(`\n  Query: "${r.query}"`);
    console.log(`  Type: ${r.type} | Overlap: ${r.overlap.length}/10 | Flat: ${r.flatMs}ms | Explore: ${r.exploreMs}ms`);
    
    if (r.exploreOnly.length > 0) {
      console.log(`  EXPLORE FOUND (flat missed):`);
      for (const t of r.exploreOnly.slice(0, 5)) {
        console.log(`    + ${t.substring(0, 90)}`);
      }
    }
    if (r.flatOnly.length > 0) {
      console.log(`  FLAT FOUND (explore missed):`);
      for (const t of r.flatOnly.slice(0, 5)) {
        console.log(`    - ${t.substring(0, 90)}`);
      }
    }
  }

  // Summary
  const avgOverlap = results.reduce((s, r) => s + r.overlap.length, 0) / results.length;
  const avgExploreOnly = results.reduce((s, r) => s + r.exploreOnly.length, 0) / results.length;
  const avgFlatOnly = results.reduce((s, r) => s + r.flatOnly.length, 0) / results.length;
  const avgFlatMs = results.reduce((s, r) => s + r.flatMs, 0) / results.length;
  const avgExploreMs = results.reduce((s, r) => s + r.exploreMs, 0) / results.length;

  console.log("\n" + "=".repeat(80));
  console.log("  SUMMARY");
  console.log("=".repeat(80));
  console.log(`  Avg overlap:        ${avgOverlap.toFixed(1)}/10`);
  console.log(`  Avg explore-only:   ${avgExploreOnly.toFixed(1)} notes (found by explore, missed by flat)`);
  console.log(`  Avg flat-only:      ${avgFlatOnly.toFixed(1)} notes (found by flat, missed by explore)`);
  console.log(`  Avg flat latency:   ${avgFlatMs.toFixed(0)}ms`);
  console.log(`  Avg explore latency: ${avgExploreMs.toFixed(0)}ms`);
  console.log("=".repeat(80));
}

main().catch(e => { console.error(e); process.exit(1); });
