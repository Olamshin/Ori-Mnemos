# Local Warmth Audit

This is a local-only evaluation workflow for the current warmth implementation.

It is not part of the public product contract. It exists so we can use Ori on a real vault, inspect how the `20%` warmth signal changes retrieval, and tune the system before we decide what should ship more broadly.

## What We Built

Current behavior:

- warmth is now a fourth retrieval signal
- retrieval fusion uses:
  - `composite`
  - `keyword`
  - `graph`
  - `warmth`
- warmth is configured to contribute `20%` of the fused retrieval weighting
- `ori_warmth` exists as an inspectable MCP tool
- ranked retrieval now carries enough score information to compare:
  - final ranking with warmth
  - base ranking without warmth

The relevant implementation pieces are:

- `src/core/warmth.ts`
  - computes the warmth field from current query/context
  - semantic seed selection
  - graph propagation with unweighted PPR
  - normalized graph merge
  - per-process cache via `WarmthService`
- `src/core/fusion.ts`
  - adds warmth as a fourth weighted fusion signal
  - keeps `rrf_base` alongside final `rrf`
- `src/cli/search.ts`
  - builds warmth results during ranked retrieval
  - logs local warmth audit events when enabled
  - exposes warmth audit query results
- `src/core/warmth-audit.ts`
  - local JSONL audit log helpers
  - newest-first querying and simple filtering
- `src/cli/serve.ts`
  - exposes `ori_warmth`

## Local-Only Audit Logging

The audit log is off by default.

Turn it on for the current PowerShell session:

```powershell
$env:ORI_WARMTH_AUDIT='1'
```

Optional: write to a custom local file instead of the default path:

```powershell
$env:ORI_WARMTH_AUDIT_PATH='.ori/my-warmth-log.jsonl'
```

Default log path:

```text
.ori/warmth-audit.jsonl
```

This logging is local-only and opt-in. It should be used while testing and tuning, not assumed as always-on product behavior.

## PowerShell Workflow

### 1. Turn audit logging on

```powershell
$env:ORI_WARMTH_AUDIT='1'
```

### 2. Run a few ranked queries

```powershell
ori query ranked "token incentives and mechanism design"
ori query ranked "ori install model and client adapters"
ori query ranked "courtshare tokenomics and growth loops"
```

### 3. Inspect the last few warmth diffs

```powershell
ori query warmth-audit --limit 5
```

### 4. Filter the log to a query theme

```powershell
ori query warmth-audit token --limit 10
ori query warmth-audit ori --limit 10
```

### 5. Turn logging back off for the current session

```powershell
Remove-Item Env:ORI_WARMTH_AUDIT
Remove-Item Env:ORI_WARMTH_AUDIT_PATH -ErrorAction SilentlyContinue
```

## How To Ask For It Later

If you tell me:

```text
for our last couple queries, pull up the diffs due to warmth
```

I can do that directly by reading the audit log through:

```powershell
ori query warmth-audit --limit 5
```

If you want a topic-specific slice, I can run:

```powershell
ori query warmth-audit token --limit 5
```

So yes: the local audit path is usable for natural follow-up requests like:

- `show the last 3 warmth diffs`
- `pull the last couple queries and show what warmth changed`
- `show token-related warmth promotions`
- `show what warmth promoted that base retrieval would not have surfaced`

## Audit Event Shape

Each audit event records:

- `timestamp`
- `query`
- `intent`
- `limit`
- `effectiveWarmthWeight`
- `withWarmth`
- `withoutWarmth`
- `promoted`
- `demoted`

Each entry inside `withWarmth` / `withoutWarmth` includes:

- `title`
- `finalRank`
- `baseRank`
- `finalScore`
- `baseScore`
- `warmthScore`
- `movement`

Meaning:

- `withWarmth` = what the top results looked like after warmth influenced fusion
- `withoutWarmth` = what the top results would have looked like from base fusion alone
- `promoted` = notes that moved up because of warmth
- `demoted` = notes that moved down because of warmth

## What To Look For During Local Testing

Good signs:

- warmth promotes notes that feel associatively correct, not random
- graph-near notes surface when they add real value
- promoted notes often feel like “I wouldn’t have thought to search that directly, but yes, that belongs here”
- warmth changes ranking without making strong direct matches disappear

Bad signs:

- graph-near but irrelevant notes keep jumping up
- warmth consistently demotes clearly stronger semantic matches
- the same stale cluster keeps surfacing regardless of query context
- rank movement exists but feels arbitrary rather than cognitively helpful

## Future Build Notes

What this local audit setup is for:

- measuring whether `20%` is too weak or too aggressive
- understanding which note types benefit most from warmth
- deciding whether warmth should move deeper into retrieval
- deciding when to evolve from query-conditioned warmth to always-on event-driven warmth

Likely next build directions:

1. Better warmth evaluation tooling
- add a cleaner summary view over the audit log
- show aggregate promotion patterns over multiple queries
- cluster promoted notes by project or community

2. Retrieval tuning
- tune warmth weight above or below `20%`
- decide whether warmth should stay a fusion signal or become a stronger retrieval prior
- test whether graph-heavy or semantic-heavy warmth works better for real usage

3. Persistent / event-driven warmth
- update warmth on note access events
- add time decay
- add spreading from accessed notes over time
- let orient/planning/linking read from the persistent warmth field

4. Better inspectability
- expose a debug mode for ranked retrieval directly
- show exactly how much warmth contribution affected a note’s final score
- add higher-level summaries like “warmth surfaced 2 graph-near notes that base retrieval missed”

## Current Practical Rule

For now:

- use `ori query ranked ...` for real retrieval
- keep `ORI_WARMTH_AUDIT=1` on when you want to study behavior
- use `ori query warmth-audit --limit N` to review recent diffs
- use `ori_warmth` when you want to inspect the warmth field directly without full retrieval

That is the current sandbox for tuning warmth against real daily use.
