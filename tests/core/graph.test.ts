import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  buildGraph,
  GraphCache,
  findOrphans,
  findDanglingLinks,
  findBacklinks,
} from "../../src/core/graph.js";

let tmpDir: string;
let notesDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ori-test-graph-"));
  notesDir = path.join(tmpDir, "notes");
  await fs.mkdir(notesDir);
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeNote(name: string, content: string) {
  await fs.writeFile(path.join(notesDir, `${name}.md`), content, "utf8");
}

describe("buildGraph", () => {
  it("extracts [[wiki-link]] targets into outgoing map", async () => {
    await writeNote("alpha", "Links to [[beta]] and [[gamma]].");
    const graph = await buildGraph(notesDir);
    const links = graph.outgoing.get("alpha");
    expect(links).toBeDefined();
    expect(links!.has("beta")).toBe(true);
    expect(links!.has("gamma")).toBe(true);
  });

  it("populates incoming (reverse) map", async () => {
    await writeNote("alpha", "Links to [[beta]].");
    await writeNote("gamma", "Also links to [[beta]].");
    const graph = await buildGraph(notesDir);
    const incoming = graph.incoming.get("beta");
    expect(incoming).toBeDefined();
    expect(incoming!.has("alpha")).toBe(true);
    expect(incoming!.has("gamma")).toBe(true);
  });

  it("handles notes with no links", async () => {
    await writeNote("lonely", "No links here.");
    const graph = await buildGraph(notesDir);
    expect(graph.outgoing.get("lonely")?.size ?? 0).toBe(0);
  });

  it("returns empty maps for missing directory", async () => {
    const graph = await buildGraph(path.join(tmpDir, "nonexistent"));
    expect(graph.outgoing.size).toBe(0);
    expect(graph.incoming.size).toBe(0);
  });

  it("normalizes whitespace in link targets to a slug", async () => {
    await writeNote("note", "Link to [[ spaced target ]].");
    const graph = await buildGraph(notesDir);
    expect(graph.outgoing.get("note")!.has("spaced-target")).toBe(true);
  });

  it("resolves display-title wikilinks to the note slug", async () => {
    // A note's identity is its filename slug, but links are authored against
    // the display title. These must resolve to the same node.
    await writeNote("vikunja-gtd-workflow-conventions", "A note.");
    await writeNote(
      "hermes-agent-configuration-preferences",
      "Relevant: [[Vikunja GTD Workflow Conventions]].",
    );
    const graph = await buildGraph(notesDir);
    expect(
      graph.outgoing
        .get("hermes-agent-configuration-preferences")!
        .has("vikunja-gtd-workflow-conventions"),
    ).toBe(true);
    const allNotes = [
      "vikunja-gtd-workflow-conventions",
      "hermes-agent-configuration-preferences",
    ];
    expect(findOrphans(graph, allNotes)).not.toContain(
      "vikunja-gtd-workflow-conventions",
    );
  });

  it("strips aliases and heading refs from wikilinks", async () => {
    await writeNote("target-note", "Target.");
    await writeNote("a", "See [[Target Note|the target]].");
    await writeNote("b", "See [[Target Note#Some Heading]].");
    const graph = await buildGraph(notesDir);
    expect(graph.incoming.get("target-note")!.has("a")).toBe(true);
    expect(graph.incoming.get("target-note")!.has("b")).toBe(true);
  });

  it("deduplicates links within the same note", async () => {
    await writeNote("note", "[[alpha]] and [[alpha]] again.");
    const graph = await buildGraph(notesDir);
    expect(graph.outgoing.get("note")!.size).toBe(1);
  });

  it("skips archived notes as graph nodes", async () => {
    await writeNote(
      "archived",
      "---\nstatus: archived\n---\nLinks to [[active]].",
    );
    await writeNote("active", "Plain note.");
    const graph = await buildGraph(notesDir);
    expect(graph.outgoing.has("archived")).toBe(false);
    expect(graph.incoming.get("active")?.has("archived") ?? false).toBe(false);
  });
});

describe("findOrphans", () => {
  it("returns notes with no incoming links", async () => {
    await writeNote("linked", "Content.");
    await writeNote("linker", "See [[linked]].");
    await writeNote("orphan", "Nobody links here.");
    const graph = await buildGraph(notesDir);
    const allNotes = ["linked", "linker", "orphan"];
    const orphans = findOrphans(graph, allNotes);
    expect(orphans).toContain("linker");
    expect(orphans).toContain("orphan");
    expect(orphans).not.toContain("linked");
  });

  it("returns all notes when none are linked", async () => {
    await writeNote("a", "Just text.");
    await writeNote("b", "More text.");
    const graph = await buildGraph(notesDir);
    const orphans = findOrphans(graph, ["a", "b"]);
    expect(orphans.sort()).toEqual(["a", "b"]);
  });
});

describe("findDanglingLinks", () => {
  it("returns targets that do not exist as notes", async () => {
    await writeNote("note", "See [[nonexistent]] and [[also-missing]].");
    const graph = await buildGraph(notesDir);
    const dangling = findDanglingLinks(graph, ["note"]);
    expect(dangling).toContain("nonexistent");
    expect(dangling).toContain("also-missing");
  });

  it("returns empty array when all links resolve", async () => {
    await writeNote("alpha", "See [[beta]].");
    await writeNote("beta", "See [[alpha]].");
    const graph = await buildGraph(notesDir);
    const dangling = findDanglingLinks(graph, ["alpha", "beta"]);
    expect(dangling).toEqual([]);
  });

  it("returns sorted results", async () => {
    await writeNote("note", "See [[zebra]] and [[aardvark]].");
    const graph = await buildGraph(notesDir);
    const dangling = findDanglingLinks(graph, ["note"]);
    expect(dangling).toEqual(["aardvark", "zebra"]);
  });
});

describe("findBacklinks", () => {
  it("returns sorted list of notes linking to target", async () => {
    await writeNote("c", "See [[target]].");
    await writeNote("a", "Also see [[target]].");
    await writeNote("b", "And [[target]] too.");
    await writeNote("target", "I am the target.");
    const graph = await buildGraph(notesDir);
    const backlinks = findBacklinks(graph, "target");
    expect(backlinks).toEqual(["a", "b", "c"]);
  });

  it("returns empty array for note with no backlinks", async () => {
    await writeNote("lonely", "No one links here.");
    const graph = await buildGraph(notesDir);
    expect(findBacklinks(graph, "lonely")).toEqual([]);
  });

  it("returns empty array for nonexistent note", async () => {
    const graph = await buildGraph(notesDir);
    expect(findBacklinks(graph, "nonexistent")).toEqual([]);
  });
});

describe("GraphCache", () => {
  it("builds on first get and returns the same graph instance on second get", async () => {
    await writeNote("alpha", "Links to [[beta]].");
    await writeNote("beta", "No links.");

    const cache = new GraphCache();
    const first = await cache.get(notesDir);
    const second = await cache.get(notesDir);

    expect(second).toBe(first);
    expect(second.outgoing.get("alpha")?.has("beta")).toBe(true);
  });

  it("invalidate forces a rebuild on next get", async () => {
    await writeNote("alpha", "No links.");

    const cache = new GraphCache();
    const first = await cache.get(notesDir);

    await writeNote("beta", "No links.");
    cache.invalidate();

    const rebuilt = await cache.get(notesDir);

    expect(rebuilt).not.toBe(first);
    expect(rebuilt.outgoing.has("beta")).toBe(true);
  });
});
