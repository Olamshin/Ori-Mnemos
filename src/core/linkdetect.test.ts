import { describe, it, expect } from "vitest";
import { suggestLinks, type VaultIndex } from "./linkdetect.js";

function makeVaultIndex(
  titles: string[],
  frontmatter: Map<string, Record<string, unknown>> = new Map(),
): VaultIndex {
  return {
    titles,
    frontmatter,
    graph: { outgoing: new Map(), incoming: new Map() },
  };
}

describe("suggestLinks", () => {
  it("skips project-overlap when project has more than 10 notes", () => {
    // 15 notes all sharing the same project
    const titles = Array.from({ length: 15 }, (_, i) => `note-${i}`);
    const frontmatter = new Map(
      titles.map((t) => [t, { project: ["big-project"] }]),
    );
    const vaultIndex = makeVaultIndex(titles, frontmatter);

    const suggestions = suggestLinks(
      { project: ["big-project"] },
      "some body text with no title matches",
      vaultIndex,
    );

    const projectSuggestions = suggestions.filter(
      (s) => s.reason === "project-overlap",
    );
    expect(projectSuggestions).toHaveLength(0);
  });

  it("keeps project-overlap when project has 10 or fewer notes", () => {
    const titles = ["note-a", "note-b", "note-c"];
    const frontmatter = new Map(
      titles.map((t) => [t, { project: ["small-project"] }]),
    );
    const vaultIndex = makeVaultIndex(titles, frontmatter);

    const suggestions = suggestLinks(
      { project: ["small-project"] },
      "unrelated body",
      vaultIndex,
    );

    const projectSuggestions = suggestions.filter(
      (s) => s.reason === "project-overlap",
    );
    expect(projectSuggestions.length).toBeGreaterThan(0);
  });

  it("caps total suggestions to 5", () => {
    // 8 notes with tag overlap to generate many suggestions
    const titles = Array.from({ length: 8 }, (_, i) => `tagged-${i}`);
    const frontmatter = new Map(
      titles.map((t) => [t, { tags: ["common-tag"] }]),
    );
    const vaultIndex = makeVaultIndex(titles, frontmatter);

    const suggestions = suggestLinks(
      { tags: ["common-tag"] },
      "unrelated body",
      vaultIndex,
    );

    expect(suggestions.length).toBeLessThanOrEqual(5);
  });
});
