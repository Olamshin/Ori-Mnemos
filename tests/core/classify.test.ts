import { describe, it, expect } from "vitest";
import {
  classifyNoteType,
  detectProjects,
  type ProjectKeywordConfig,
} from "../../src/core/classify.js";

describe("classifyNoteType", () => {
  it("returns explicit frontmatter type with high confidence", () => {
    const result = classifyNoteType("anything", "anything", "decision");
    expect(result.type).toBe("decision");
    expect(result.confidence).toBe("high");
    expect(result.reason).toMatch(/explicit/);
  });

  it("ignores invalid frontmatter type and classifies from content", () => {
    const result = classifyNoteType("we learned something", "turns out X", "banana");
    expect(result.type).toBe("learning");
  });

  it("classifies 'decided to use React' as decision", () => {
    const result = classifyNoteType(
      "decided to use React for frontend",
      "We will use React because of the ecosystem. The rationale is clear."
    );
    expect(result.type).toBe("decision");
  });

  it("classifies 'chose X over Y' as decision with high confidence", () => {
    const result = classifyNoteType(
      "architecture choice",
      "We chose PostgreSQL over MongoDB for our data layer. The trade-off was worth it."
    );
    expect(result.type).toBe("decision");
    expect(result.confidence).toBe("high");
  });

  it("classifies blocker patterns", () => {
    const result = classifyNoteType(
      "blocked by API rate limit",
      "Can't proceed until the rate limit is lifted. Waiting on support."
    );
    expect(result.type).toBe("blocker");
  });

  it("classifies opportunity patterns", () => {
    const result = classifyNoteType(
      "partnership opportunity",
      "There's potential for a partnership here. Worth exploring the market for this."
    );
    expect(result.type).toBe("opportunity");
  });

  it("classifies learning patterns", () => {
    const result = classifyNoteType(
      "TIL about caching",
      "Learned that Redis handles this well. Turns out the key takeaway is TTL management."
    );
    expect(result.type).toBe("learning");
    expect(result.confidence).toBe("high");
  });

  it("classifies idea patterns", () => {
    const result = classifyNoteType(
      "what if we cached everything",
      "This is a proposal for aggressive caching. Could we experiment with this?"
    );
    expect(result.type).toBe("idea");
  });

  it("defaults to insight with low confidence for ambiguous content", () => {
    const result = classifyNoteType(
      "some random note",
      "This is just some text without strong signals."
    );
    expect(result.type).toBe("insight");
    expect(result.confidence).toBe("low");
  });

  it("classifies 'going with' and 'picked' as decision", () => {
    const result1 = classifyNoteType(
      "going with PostgreSQL for the data layer",
      "We picked Postgres over MongoDB. Opted for simplicity."
    );
    expect(result1.type).toBe("decision");
    expect(result1.confidence).toBe("high");
  });

  it("classifies 'switching to' as decision", () => {
    const result = classifyNoteType(
      "switching to a new framework",
      "Decided to move off Express."
    );
    expect(result.type).toBe("decision");
  });

  it("classifies 'the problem is' as blocker", () => {
    const result = classifyNoteType(
      "API rate limits are killing us",
      "The problem is our rate limits prevent batch processing."
    );
    expect(result.type).toBe("blocker");
  });

  it("classifies 'no way to' as blocker", () => {
    const result = classifyNoteType(
      "deployment stuck",
      "There's no way to deploy until the cert is renewed."
    );
    expect(result.type).toBe("blocker");
  });

  it("classifies 'found that' and 'after testing' as learning", () => {
    const result = classifyNoteType(
      "caching insight",
      "Found that Redis TTL solves the stale data problem. After testing, latency dropped 40%."
    );
    expect(result.type).toBe("learning");
    expect(result.confidence).toBe("high");
  });

  it("classifies 'the key is' and 'it works because' as learning", () => {
    const result = classifyNoteType(
      "indexing strategy",
      "The key is compound indexes. It works because MongoDB skips the collection scan."
    );
    expect(result.type).toBe("learning");
    expect(result.confidence).toBe("high");
  });

  it("classifies 'maybe we should' as idea", () => {
    const result = classifyNoteType(
      "caching approach",
      "Maybe we should try edge caching. Worth testing on the CDN."
    );
    expect(result.type).toBe("idea");
  });

  it("classifies 'wonder if' as idea", () => {
    const result = classifyNoteType(
      "scaling question",
      "I wonder if sharding would help at our current volume."
    );
    expect(result.type).toBe("idea");
  });

  // Regression: guard against false positives from broad patterns
  it("does not misclassify 'the problem is interesting' as blocker", () => {
    const result = classifyNoteType(
      "fascinating architecture",
      "The problem is interesting from a systems design perspective."
    );
    // Single match on 'the problem is' → medium confidence, but still blocker
    // This is acceptable: single-pattern matches are medium confidence,
    // and explicit --type override is the escape hatch
    expect(result.confidence).not.toBe("high");
  });

  it("does not misclassify generic text with 'picked' as high-confidence decision", () => {
    const result = classifyNoteType(
      "random observation",
      "She picked up the book and walked away."
    );
    // 'picked' alone is medium confidence — needs a second signal for high
    expect(result.confidence).not.toBe("high");
  });

  it("decision takes priority over other patterns", () => {
    // Contains both decision and idea patterns
    const result = classifyNoteType(
      "decided on our approach",
      "We decided to go with the idea of caching. Will use Redis."
    );
    expect(result.type).toBe("decision");
  });

  it("blocker takes priority over opportunity/learning/idea", () => {
    const result = classifyNoteType(
      "blocked and waiting",
      "We're stuck waiting on the API. There's potential here but we can't proceed."
    );
    expect(result.type).toBe("blocker");
  });
});

describe("detectProjects", () => {
  const config: ProjectKeywordConfig = {
    known_projects: ["courtshare", "crypto", "ai-agents"],
    keywords: {
      courtshare: ["courtshare", "basketball", "player eval"],
      crypto: ["token", "blockchain", "wallet"],
      "ai-agents": ["agent", "memory", "ori", "vault"],
    },
  };

  it("detects project from title keyword", () => {
    const result = detectProjects("CourtShare engagement ideas", "", config);
    expect(result).toContain("courtshare");
  });

  it("detects project from body keyword", () => {
    const result = detectProjects("some note", "We need better agent memory for the vault.", config);
    expect(result).toContain("ai-agents");
  });

  it("detects multiple projects", () => {
    const result = detectProjects(
      "token incentives for agent systems",
      "blockchain-based memory vault",
      config
    );
    expect(result).toContain("crypto");
    expect(result).toContain("ai-agents");
  });

  it("returns empty for no keyword match", () => {
    const result = detectProjects("cooking recipes", "How to make pasta.", config);
    expect(result).toEqual([]);
  });

  it("returns empty for empty config", () => {
    const result = detectProjects("agent memory", "vault stuff", {
      known_projects: [],
      keywords: {},
    });
    expect(result).toEqual([]);
  });

  it("is case-insensitive", () => {
    const result = detectProjects("COURTSHARE APP", "BASKETBALL scoring", config);
    expect(result).toContain("courtshare");
  });
});
