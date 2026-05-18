---
description: How you process knowledge — principles, workflow, quality gates
type: self
---

# Methodology

## Processing Principles

## Session Rhythm
**Orient → Work → Persist**

### Orient (always first)
- Call `ori_orient` for session briefing
- Read `ori://identity` or `ori://goals` for context when needed

### Work
- Query knowledge base (`ori_query_ranked`) before creating new content
- Capture insights to inbox via `ori_add` with `content` parameter populated (never leave template stubs)
- Promote via `ori_promote` with classification and linking

### Persist
- Update daily notes via `ori_update file=daily`
- Validate notes created during session
- End-of-session: use `ori_add` to write a session summary with key decisions, insights, and open threads
- Archive completed or stale items periodically

## Evolved Patterns
