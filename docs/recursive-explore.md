# Recursive Explore (RMH Constraint 2)

`ori_explore` supports recursive sub-question decomposition — when the initial retrieval doesn't fully answer a query, the system identifies gaps and searches again until the answer is complete or the budget is exhausted.

## How It Works

1. **Pass 0**: Standard explore — semantic + BM25 + PPR + warmth fusion, expanded with graph traversal
2. **Gap detection**: An LLM reads the results so far and generates 1-3 sub-questions about what's missing
3. **Recursive passes**: Each sub-question seeds a new explore pass. Only NEW notes (not already found) are added
4. **Convergence**: Stops when the LLM returns no sub-questions (fully answered), new notes drop below threshold, or max depth is reached

## LLM Provider Setup

Recursive explore requires an LLM provider configured in `ori.config.yaml`. The LLM does exactly one thing: identify gaps in retrieved results. This is a lightweight task — any model 3B+ can handle it.

### Groq (free tier, recommended)

```yaml
llm:
  provider: "openai"
  model: "llama-3.3-70b-versatile"
  api_key_env: "GROQ_API_KEY"
  base_url: "https://api.groq.com/openai/v1"
```

Set `GROQ_API_KEY` in your environment. Free tier: 30 requests/minute.

### Ollama (fully local, no API key)

```yaml
llm:
  provider: "openai"
  model: "qwen2.5:3b"
  api_key_env: "OLLAMA_DUMMY"
  base_url: "http://localhost:11434/v1"
```

Set `OLLAMA_DUMMY=dummy` (Ollama ignores the key but Ori requires one). Run `ollama pull qwen2.5:3b` first.

### OpenAI

```yaml
llm:
  provider: "openai"
  model: "gpt-4o-mini"
  api_key_env: "OPENAI_API_KEY"
```

### Anthropic

```yaml
llm:
  provider: "anthropic"
  model: "claude-haiku-4-5-20251001"
  api_key_env: "ANTHROPIC_API_KEY"
```

### Any OpenAI-compatible API

```yaml
llm:
  provider: "openai"
  model: "your-model-name"
  api_key_env: "YOUR_API_KEY_ENV"
  base_url: "https://your-api.com/v1"
```

Works with Together AI, OpenRouter, vLLM, LM Studio, and any OpenAI-compatible endpoint.

## Graceful Degradation

If no LLM is configured, `ori_explore` falls back to single-pass explore (Phase 1 only). This still includes PPR graph traversal, warmth signals, and Q-value reranking — just no recursive sub-question decomposition. Phase 1 alone achieves ~95% recall on direct queries.

## Configuration

Explore config lives in `ori.config.yaml` under the `explore` section (or uses defaults):

```yaml
explore:
  recursive_enabled: true       # Enable/disable recursion (default: true)
  max_recursion_depth: 2        # Max recursive passes (default: 2)
  max_total_notes: 30           # Budget: stop if this many unique notes found
  convergence_threshold: 0.15   # Stop if new_notes/total < this ratio
  sub_question_max: 3           # Max sub-questions per pass
```

## CLI Usage

```bash
# Recursive (default when LLM is configured)
ori explore "How does warmth affect retrieval quality"

# Disable recursion
ori explore "How does warmth affect retrieval quality" --no-recursive

# Deep exploration
ori explore "Cross-project connections between crypto and CourtShare" --depth 3
```

## MCP Tool

```
ori_explore(query, limit?, depth?, recursive?)
```

The `recursive` parameter defaults to `true` when an LLM provider is configured.

## Audit Logging

Set `ORI_EXPLORE_AUDIT=true` to log detailed recursion data to `.ori/explore-audit.jsonl`. Each entry captures:

- Flat results vs final results (what recursion changed)
- Recursion gains (notes only recursion found)
- Recursion losses (flat notes displaced by better recursive finds)
- Sub-questions generated at each depth
- Per-pass breakdown (notes found, new notes added)
- Convergence status and timing

This data is local-only (`.ori/` is gitignored) and useful for tuning recursion parameters.
