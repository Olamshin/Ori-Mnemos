# Benchmarks

## Datasets

- **HotpotQA** — Multi-hop question answering. Each question requires finding and combining information from exactly 2 documents out of 10 (2 gold, 8 distractors). Tests graph-relative retrieval.
- **LoCoMo** — Long-context conversational memory. 10 conversations, 695 questions across single-hop, multi-hop, and temporal categories.

## Evaluation Scripts

### HotpotQA (Ori flat vs Ori explore vs Mem0)

```bash
# Ori (flat + explore, head-to-head)
npx tsx bench/hotpotqa-eval.ts --n 50 --json

# Mem0 comparison (requires pip install mem0ai)
python bench/mem0-hotpotqa.py
```

### LoCoMo

```bash
# Full benchmark (695 questions, all categories)
npx tsx bench/locomo-eval.ts --json

# Single conversation
npx tsx bench/locomo-eval.ts --sample 0

# Filter by question type (1=multi-hop, 2=single-hop, 3=temporal)
npx tsx bench/locomo-eval.ts --categories 1,2,3
```

## Latest Results

### HotpotQA (50 questions, same dataset, same scoring)

| System | R@5 | F1 | LLM-F1 | Speed | API for ingestion |
|---|---|---|---|---|---|
| Ori flat | 87.0% | 50.6% | 40.3% | 142s | None (local) |
| Ori explore | 90.0% | 52.3% | 41.0% | 142s | None (local) |
| Mem0 | 29.0% | 25.7% | 18.8% | 1347s | ~500 LLM calls |

### LoCoMo (695 questions)

| Category | Count | Recall | F1 | MRR | AnsF1 |
|---|---|---|---|---|---|
| Single-hop | 321 | 55.6% | 19.9% | 29.9% | 70.6% |
| Multi-hop | 282 | 38.2% | 24.6% | 38.8% | 61.3% |
| Temporal | 92 | 26.6% | 12.5% | 21.8% | 45.5% |
| **Overall** | **695** | **44.7%** | **20.8%** | **32.4%** | **63.5%** |

## Data

- `data/hotpotqa-dev.json` — HotpotQA dev set (200 questions)
- `data/locomo10.json` — LoCoMo 10-conversation dataset

## Results

JSON output from each benchmark run stored in `results/` with timestamps.
