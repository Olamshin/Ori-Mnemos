# Ori Mnemos

**Open-source persistent memory for AI agents.**

Install it on any machine, point your agent at it, and it wakes up knowing who it is. Not because you pasted context into a system prompt. Because it has a memory system that learns what matters, forgets what doesn't, and keeps your agent's knowledge in files you own.

Markdown on disk. Wiki-links as graph edges. Git as version control. No database, no cloud, no lock-in.

**v0.3.5** · npm package · Apache-2.0

---

## Quick Start

```bash
npm install -g ori-memory
ori init my-agent
cd my-agent
```

Connect Ori to your client:

```bash
ori bridge claude-code --scope global --activation auto --vault ~/brain
ori bridge cursor --scope project --activation manual --vault ~/brain
```

Or use the generic/manual install plan for any MCP client:

```bash
ori bridge generic --scope global --activation manual --vault ~/brain
```

That prints the MCP server command, args, env, and install notes. For scripting, add `--json`.

Manual MCP shape:

```json
{
  "mcpServers": {
    "ori": {
      "command": "ori",
      "args": ["serve", "--mcp", "--vault", "/path/to/brain"],
      "env": {
        "ORI_VAULT": "/path/to/brain"
      }
    }
  }
}
```

Start a session. The agent receives its identity automatically and begins onboarding on first run.

---

## What It Does

- **Persistent identity.** Agents wake up as themselves. Name, personality, goals, methodology travel with the vault across sessions, clients, and machines.

- **Four-signal retrieval.** Not just vector search. Semantic embeddings + BM25 keyword matching + PageRank graph importance + associative warmth, fused through Reciprocal Rank Fusion with automatic intent classification. Warmth is inspectable and now influences ranked retrieval directly.

- **Knowledge graph.** Every `[[wiki-link]]` is a graph edge. PageRank authority, Louvain community detection, betweenness centrality, orphan and dangling link detection. Structure is queryable.

- **Graph-aware forgetting.** Notes decay using ACT-R cognitive science. Used notes stay alive. Their neighbors stay warm through spreading activation along wiki-link edges. Structurally critical nodes are protected by Tarjan's algorithm. No other shipped memory system does this.

- **Zone classification.** Notes are `active`, `stale`, `fading`, or `archived` based on vitality score. `ori prune` analyzes the full activation topology, identifies archive candidates, and protects articulation points. Dry-run by default.

- **Capture-promote pipeline.** `ori add` captures to inbox. `ori promote` classifies (idea, decision, learning, insight, blocker, opportunity), detects links, suggests areas. 50+ heuristic patterns. Optional LLM enhancement.

- **Zero cloud dependencies.** Local embeddings via all-MiniLM-L6-v2 running in-process. SQLite for vectors. Everything on your filesystem. Zero API keys required for core functionality.

---

## Token Economics

Without retrieval, every question requires dumping the entire vault into context. With Ori, the cost stays flat.

| Vault Size | Without Ori | With Ori | Savings |
|:----------:|:-----------:|:--------:|:-------:|
| 50 notes | 10,100 tokens | 850 tokens | **91%** |
| 200 notes | 40,400 tokens | 850 tokens | **98%** |
| 1,000 notes | 202,000 tokens | 850 tokens | **99.6%** |
| 5,000 notes | 1,010,000 tokens | 850 tokens | **99.9%** |

A typical session costs **~$0.10** with Ori. Without it: **~$6.00+**.

---

## The Stack

```
Layer 4: MCP Server (15 tools, 5 resources)     any agent talks to this
Layer 3: Four-Signal Retrieval Engine            semantic + keyword + graph + warmth
Layer 2: Knowledge Graph + Vitality Model        wiki-links, ACT-R decay, spreading activation
Layer 1: Markdown files on disk                  git-friendly, human-readable, portable
```

15 MCP tools. 5 resources. 16 CLI commands. 455 tests.

---

## Three Spaces

Every vault has three memory spaces with distinct decay rates.

| Space | Path | Decay | What lives here |
|-------|------|-------|-----------------|
| **Identity** | `self/` | 0.1x | Who the agent is. Name, goals, methodology. Barely decays. |
| **Knowledge** | `notes/` | 1.0x | What the agent knows. Ideas, decisions, learnings, connections. |
| **Operations** | `ops/` | 3.0x | What the agent is doing. Daily tasks, reminders, sessions. Decays fast. |

Identity persists. Knowledge lives and dies by relevance. Operational state burns hot and clears itself.

---

## Architecture

```
                          Any MCP Client
                    (Claude, Cursor, Windsurf,
                     Cline, custom agents, VPS)
                              |
                        MCP Protocol
                        (stdio / JSON-RPC)
                              |
                    +-------------------+
                    |    Ori MCP Server  |
                    |                   |
                    |  instructions     |   identity auto-injected at connect
                    |  resources        |   5 readable endpoints (ori://)
                    |  15 tools         |   full memory operations
                    +-------------------+
                              |
          +-------------------+-------------------+
          |                   |                   |
    +-----------+      +------------+      +------------+
    | Knowledge |      |  Identity  |      | Operations |
    |   Graph   |      |   Layer    |      |   Layer    |
    |           |      |            |      |            |
    |  notes/   |      |  self/     |      |  ops/      |
    |  inbox/   |      |  identity  |      |  daily     |
    |  templates|      |  goals     |      |  reminders |
    |           |      |  method.   |      |  sessions  |
    +-----------+      +------------+      +------------+
          |
    +-----+------+
    |            |
 Wiki-link   Embedding
  Graph       Index
 (in-memory)  (SQLite)
    |            |
 PageRank    Semantic
 Spreading   Search
 Activation  BM25
 Communities 3-Signal Fusion
```

---

## MCP Tools

| Tool | What it does |
|------|-------------|
| `ori_orient` | Session briefing: daily status, goals, reminders, vault health |
| `ori_update` | Write to identity, goals, methodology, daily, or reminders |
| `ori_status` | Vault overview |
| `ori_health` | Full diagnostics |
| `ori_add` | Capture to inbox |
| `ori_promote` | Promote with classification, linking, and area assignment |
| `ori_validate` | Schema validation against templates |
| `ori_query` | Graph queries: orphans, dangling, backlinks, cross-project |
| `ori_query_ranked` | Four-signal retrieval with spreading activation and warmth comparison |
| `ori_warmth` | Inspect the current associative warmth field without retrieving note content |
| `ori_query_similar` | Semantic search (vector only, faster) |
| `ori_query_important` | PageRank authority ranking |
| `ori_query_fading` | Vitality-based decay detection |
| `ori_prune` | Activation topology and archive candidates |
| `ori_index_build` | Build or update the embedding index |

---

## CLI

```bash
# Vault management
ori init [dir]                    # Scaffold a new vault
ori status                        # Vault overview
ori health                        # Full diagnostics

# Note lifecycle
ori add <title> [--type <type>]   # Capture to inbox
ori promote [note] [--all]        # Promote to knowledge graph
ori validate <path>               # Schema validation
ori archive [--dry-run]           # Archive stale notes
ori prune [--apply] [--verbose]   # Topology analysis + archive candidates

# Retrieval
ori query orphans                 # Notes with no incoming links
ori query dangling                # Broken wiki-links
ori query backlinks <note>        # What links to this note
ori query cross-project           # Multi-project notes
ori query ranked <query>          # Four-signal retrieval
ori query similar <query>         # Semantic search
ori query important               # PageRank ranking
ori query fading                  # Vitality detection

# Infrastructure
ori index build [--force]         # Build embedding index
ori index status                  # Index statistics
ori graph metrics                 # PageRank, centrality
ori graph communities             # Louvain clustering
ori serve --mcp [--vault <path>]                                # Run MCP server
ori bridge claude-code --scope <project|global>                 # Install Claude adapter
ori bridge cursor --scope <project|global>                      # Install Cursor MCP config
ori bridge claude-code --activation <auto|manual> [--vault <p>] # Control startup behavior
ori bridge generic --scope <project|global> [--json]            # Print generic MCP install plan
ori bridge status [--json]                                      # Inspect project/global bridge installs
ori bridge claude-code --scope global --uninstall               # Remove installed Claude config
ori bridge cursor --scope project --uninstall                   # Remove installed Cursor config
```

---

## Vault Structure

```
vault/
├── .ori                       # Vault marker
├── ori.config.yaml            # Configuration
├── notes/                     # Knowledge graph (flat, no subfolders)
│   └── index.md               # Hub entry point
├── inbox/                     # Capture buffer
├── templates/                 # Note and map schemas
├── self/                      # Agent identity
│   ├── identity.md            # Name, personality, values
│   ├── goals.md               # Active threads, priorities
│   ├── methodology.md         # Processing principles
│   └── memory/                # Agent's accumulated insights
└── ops/                       # Operational state
    ├── daily.md               # Today's completed and pending
    ├── reminders.md           # Time-bound commitments
    └── sessions/              # Session logs
```

Every file is plain markdown. Open it in any text editor, Obsidian, or your file browser. `git log` is your audit trail.

---

## Deployment

**Local.** Install globally, `ori init`, connect your MCP client. Done.

**VPS / headless.** Install on the server. `ori serve --mcp --vault /path/to/vault`. Memory persists on the filesystem. Back up with `git push`.

**Multi-vault.** Separate Ori instances for separate agents. Each vault is self-contained: its own identity, knowledge graph, and operational state.

**Scriptable.** CLI returns structured JSON. Use in cron jobs, webhook handlers, or orchestration loops.

## Install Model

Ori separates three install concepts:

- `scope`: `global` follows one vault across the machine, `project` stays inside one repo/workspace
- `activation`: `auto` runs `ori_orient` at session start where the adapter supports it, `manual` leaves tools available but does not auto-orient
- `vault`: explicit `--vault` wins; otherwise Ori resolves by install scope

Precedence rules:

- project install overrides global install
- explicit `--vault` overrides inferred vault
- project activation overrides global activation

Bridge lifecycle:

- rerun the same `ori bridge ...` command to update vault path or activation in place
- use `--uninstall` to remove Ori-owned config from supported adapters
- generic installs emit manual uninstall instructions because Ori does not own that client config surface

Claude Code is the first fully automated adapter. Cursor now has native MCP config install support. Other MCP-capable clients can use `ori bridge generic` now and wire the emitted config into their own client surface.

---

## Configuration

`ori.config.yaml` controls all tunable parameters. Generated with sensible defaults on `ori init`.

| Section | Controls |
|---------|----------|
| `vitality` | Decay parameters, metabolic rates, zone thresholds, bridge bonus |
| `activation` | Spreading activation: damping, max hops, min boost |
| `retrieval` | Signal weights, exploration budget |
| `engine` | Embedding model, database path |
| `promote` | Auto-promotion, project routing |
| `llm` | Optional: Anthropic, OpenAI-compatible, or local models |

LLM integration is optional. Every operation works deterministically with heuristics alone. When configured, LLM improves classification and link suggestions.

---

## Why Sovereignty Matters

Most memory systems store your agent's knowledge in infrastructure you do not control. A proprietary database. A cloud service. A vendor's format.

Ori stores memory as files you own. The vault is portable. Move it to a new machine, push it to a git remote, open it in a text editor. Switch MCP clients by changing one config line. The memory survives any platform change because it was never locked to a platform.

This is not ideological. It is architectural. Portable memory is composable memory.

---

## Development

```bash
git clone https://github.com/aayoawoyemi/Ori-Mnemos.git
cd Ori-Mnemos
npm install
npm run build
npm link
ori --version
```

```bash
npm test              # 442 tests
npm run lint          # Type check
npm run dev           # Watch mode
```

---

## License

Apache-2.0

---

Memory is sovereignty. Ori gives your agent workflow life.
