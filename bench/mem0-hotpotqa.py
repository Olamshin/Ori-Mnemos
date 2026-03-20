#!/usr/bin/env python3
"""
Mem0 HotpotQA Benchmark — head-to-head comparison with Ori.

Same dataset, same scoring, same top-K. Ingests HotpotQA context paragraphs
into a fresh Mem0 instance per question, queries, and measures retrieval.

Usage:
  python bench/mem0-hotpotqa.py                     # 100 questions
  python bench/mem0-hotpotqa.py --n 200             # 200 questions
  python bench/mem0-hotpotqa.py --n 200 --llm-judge # with LLM answer scoring
  python bench/mem0-hotpotqa.py --type bridge       # bridge only
"""

import json
import os
import re
import sys
import time
import shutil
import tempfile
import argparse
from datetime import datetime, timezone
from collections import defaultdict

from mem0 import Memory
from openai import OpenAI

# ---------------------------------------------------------------------------
# Scoring (mirrors Ori's hotpotqa-eval.ts exactly)
# ---------------------------------------------------------------------------

def recall(retrieved: list[str], gold: list[str]) -> float:
    s = set(retrieved)
    return sum(1 for t in gold if t in s) / len(gold) if gold else 0.0

def precision(retrieved: list[str], gold: list[str]) -> float:
    s = set(gold)
    return sum(1 for t in retrieved if t in s) / len(retrieved) if retrieved else 0.0

def f1(p: float, r: float) -> float:
    return (2 * p * r) / (p + r) if (p + r) > 0 else 0.0

def mrr(retrieved: list[str], gold: list[str]) -> float:
    s = set(gold)
    for i, t in enumerate(retrieved):
        if t in s:
            return 1.0 / (i + 1)
    return 0.0

def normalize_tokens(s: str) -> list[str]:
    s = s.lower()
    s = re.sub(r'\b(a|an|the)\b', ' ', s)
    s = re.sub(r'[^\w\s]', ' ', s)
    return [t for t in s.split() if t]

def answer_recall_proxy(retrieved_text: str, answer: str) -> float:
    ref = normalize_tokens(answer)
    if not ref:
        return 1.0
    ctx = set(normalize_tokens(retrieved_text))
    return sum(1 for t in ref if t in ctx) / len(ref)

def token_f1(pred: str, ref: str) -> float:
    p_toks = normalize_tokens(pred)
    r_toks = normalize_tokens(ref)
    if not r_toks:
        return 1.0 if not p_toks else 0.0
    if not p_toks:
        return 0.0
    rs = set(r_toks)
    ps = set(p_toks)
    prec = sum(1 for t in p_toks if t in rs) / len(p_toks)
    rec = sum(1 for t in r_toks if t in ps) / len(r_toks)
    return (2 * prec * rec) / (prec + rec) if (prec + rec) > 0 else 0.0

# ---------------------------------------------------------------------------
# Mem0 adapter
# ---------------------------------------------------------------------------

def sanitize_title(title: str) -> str:
    return re.sub(r'[<>:"/\\|?*]', '_', title)

def create_mem0_instance(api_key: str, storage_dir: str) -> tuple[Memory, str]:
    """Create a fresh Mem0 instance with isolated storage per question."""
    config = {
        "llm": {
            "provider": "openai",
            "config": {
                "model": "gpt-4.1-mini",
                "api_key": api_key,
            }
        },
        "embedder": {
            "provider": "openai",
            "config": {
                "model": "text-embedding-3-small",
                "api_key": api_key,
            }
        },
        "vector_store": {
            "provider": "qdrant",
            "config": {
                "collection_name": "mem0",
                "path": storage_dir,
            }
        },
        "version": "v1.1",
    }
    return Memory.from_config(config), storage_dir

def ingest_question(m: Memory, question: dict, user_id: str) -> list[str]:
    """Ingest all 10 context paragraphs into Mem0 as separate memories."""
    titles = []
    for title, sentences in question["context"]:
        safe = sanitize_title(title)
        body = " ".join(sentences)
        # Add as a memory tagged with the title so we can trace retrieval
        m.add(
            f"Topic: {title}\n\n{body}",
            user_id=user_id,
            metadata={"title": safe},
        )
        titles.append(safe)
    return titles

def query_mem0(m: Memory, query: str, user_id: str, top_k: int) -> tuple[list[str], str]:
    """Query Mem0 and return (retrieved_titles, retrieved_text)."""
    results = m.search(query, user_id=user_id, limit=top_k)

    # mem0 v1.1 returns {"results": [...]} or a list directly
    if isinstance(results, dict):
        results = results.get("results", [])

    retrieved_titles = []
    retrieved_text = ""
    for r in results[:top_k]:
        meta = r.get("metadata", {}) if isinstance(r, dict) else {}
        title = meta.get("title", "")
        memory_text = r.get("memory", "") if isinstance(r, dict) else str(r)
        if title and title not in retrieved_titles:
            retrieved_titles.append(title)
        retrieved_text += " " + memory_text

    return retrieved_titles, retrieved_text

# ---------------------------------------------------------------------------
# LLM judge (same as Ori benchmark)
# ---------------------------------------------------------------------------

def llm_answer(client: OpenAI, question: str, context: str) -> str:
    for attempt in range(5):
        try:
            resp = client.chat.completions.create(
                model="gpt-4.1-mini",
                messages=[
                    {"role": "system", "content": "Answer using ONLY the context. Short, direct answer. If unknown, say 'I don't know'."},
                    {"role": "user", "content": f"Context:\n{context[:20000]}\n\nQuestion: {question}\n\nAnswer:"},
                ],
                max_tokens=80,
                temperature=0,
            )
            return resp.choices[0].message.content.strip()
        except Exception as e:
            if "429" in str(e):
                time.sleep(2 * (2 ** attempt))
                continue
            raise
    raise RuntimeError("Max retries")

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Mem0 HotpotQA Benchmark")
    parser.add_argument("--n", type=int, default=100, help="Number of questions")
    parser.add_argument("--k", type=int, default=5, help="Top-K retrieval")
    parser.add_argument("--type", type=str, default=None, help="Filter by question type")
    parser.add_argument("--llm-judge", action="store_true", help="Add LLM answer scoring")
    parser.add_argument("--json", action="store_true", help="Save JSON results")
    args = parser.parse_args()

    api_key = os.environ.get("OPENAI_API_KEY", "")
    if not api_key:
        print("ERROR: Set OPENAI_API_KEY", file=sys.stderr)
        sys.exit(1)

    client = OpenAI(api_key=api_key) if args.llm_judge else None

    print("HotpotQA Benchmark — Mem0 Baseline")
    print("=" * 70)
    print(f"  Questions: {args.n} | Top-K: {args.k} | Type: {args.type or 'all'}")
    print(f"  LLM Judge: {args.llm_judge}")
    print("=" * 70 + "\n")

    with open("bench/data/hotpotqa-dev.json", "r") as f:
        dataset = json.load(f)

    if args.type:
        dataset = [q for q in dataset if q["type"] == args.type]
    dataset = dataset[:args.n]
    print(f"Loaded {len(dataset)} questions.\n")

    results = []
    start_time = time.time()

    for i, q in enumerate(dataset):
        gold_titles = list(set(
            sanitize_title(sf[0]) for sf in q["supporting_facts"]
        ))

        # Fresh Mem0 per question with isolated storage (like Ori gets a fresh temp vault)
        user_id = f"hotpot-{q['_id']}"
        storage_dir = tempfile.mkdtemp(prefix="mem0-hotpot-")
        try:
            m, _ = create_mem0_instance(api_key, storage_dir)
            all_titles = ingest_question(m, q, user_id)

            gold = [t for t in gold_titles if t in all_titles]
            if not gold:
                continue

            retrieved_titles, retrieved_text = query_mem0(m, q["question"], user_id, args.k)

            p = precision(retrieved_titles, gold)
            r = recall(retrieved_titles, gold)
            f = f1(p, r)
            m_score = mrr(retrieved_titles, gold)
            ans_proxy = answer_recall_proxy(retrieved_text, q["answer"])

            llm_score = -1.0
            if args.llm_judge and client:
                try:
                    ans = llm_answer(client, q["question"], retrieved_text)
                    llm_score = token_f1(ans, q["answer"])
                except Exception:
                    pass

            results.append({
                "id": q["_id"],
                "question": q["question"],
                "answer": q["answer"],
                "qtype": q["type"],
                "gold": gold,
                "retrieved": retrieved_titles,
                "R": r, "P": p, "F1": f, "MRR": m_score,
                "AnsProxy": ans_proxy, "LLM": llm_score,
            })

            if (i + 1) % 10 == 0:
                done = len(results)
                avg_f1 = sum(x["F1"] for x in results) / done
                avg_r = sum(x["R"] for x in results) / done
                elapsed = time.time() - start_time
                print(f"  [{i+1}/{len(dataset)}] R@{args.k}={avg_r:.3f}  F1={avg_f1:.3f}  ({elapsed:.0f}s)")

        except Exception as e:
            print(f"  [{i+1}] ERROR: {e}", file=sys.stderr)
            continue
        finally:
            try:
                del m
                shutil.rmtree(storage_dir, ignore_errors=True)
            except Exception:
                pass

    # ---------------------------------------------------------------------------
    # Report
    # ---------------------------------------------------------------------------
    if not results:
        print("No results.")
        return

    n = len(results)
    div = "=" * 70
    has_llm = any(x["LLM"] >= 0 for x in results)

    print(f"\n{div}")
    print("  MEM0 HOTPOTQA RESULTS")
    print(f"{div}\n")

    by_type = defaultdict(list)
    for r in results:
        by_type[r["qtype"]].append(r)

    hdr = f"  {'Type':<12}  {'N':>5}  {'R@K':>7}  {'F1':>7}  {'MRR':>7}  {'AnsProxy':>9}"
    if has_llm:
        hdr += f"  {'LLM-F1':>9}"
    print(hdr)
    print("  " + "-" * (len(hdr) - 2))

    for t in sorted(by_type.keys()):
        rs = by_type[t]
        cnt = len(rs)
        avg = lambda fn: sum(fn(x) for x in rs) / cnt
        line = f"  {t:<12}  {cnt:>5}  {avg(lambda x: x['R']):.3f}  {avg(lambda x: x['F1']):>7.3f}  {avg(lambda x: x['MRR']):>7.3f}  {avg(lambda x: x['AnsProxy'])*100:>8.1f}%"
        if has_llm:
            line += f"  {avg(lambda x: max(0, x['LLM']))*100:>8.1f}%"
        print(line)

    print("  " + "-" * (len(hdr) - 2))
    avg_all = lambda fn: sum(fn(x) for x in results) / n
    line = f"  {'OVERALL':<12}  {n:>5}  {avg_all(lambda x: x['R']):.3f}  {avg_all(lambda x: x['F1']):>7.3f}  {avg_all(lambda x: x['MRR']):>7.3f}  {avg_all(lambda x: x['AnsProxy'])*100:>8.1f}%"
    if has_llm:
        line += f"  {avg_all(lambda x: max(0, x['LLM']))*100:>8.1f}%"
    print(line)
    print(div)

    elapsed = time.time() - start_time
    print(f"\n  Total time: {elapsed:.1f}s")

    if args.json:
        os.makedirs("bench/results", exist_ok=True)
        ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%S")
        out_path = f"bench/results/mem0-hotpotqa-{ts}.json"
        summary = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "system": "mem0",
            "version": "1.0.6",
            "n": n,
            "topK": args.k,
            "mem0": {
                "R": avg_all(lambda x: x["R"]),
                "F1": avg_all(lambda x: x["F1"]),
                "MRR": avg_all(lambda x: x["MRR"]),
                "AnsProxy": avg_all(lambda x: x["AnsProxy"]),
            },
        }
        if has_llm:
            summary["mem0"]["LLM_F1"] = avg_all(lambda x: max(0, x["LLM"]))
        summary["per_question"] = results
        with open(out_path, "w") as f:
            json.dump(summary, f, indent=2)
        print(f"  Saved: {out_path}")

    # Print comparison with Ori (hardcoded from latest run)
    print(f"\n{'=' * 70}")
    print("  HEAD-TO-HEAD COMPARISON (Ori results from 200q run)")
    print(f"{'=' * 70}")
    print(f"  {'System':<12}  {'R@5':>7}  {'F1':>7}")
    print(f"  {'-'*30}")
    print(f"  {'Ori flat':<12}  {'0.883':>7}  {'0.506':>7}")
    print(f"  {'Ori explore':<12}  {'0.890':>7}  {'0.511':>7}")
    print(f"  {'Mem0':<12}  {avg_all(lambda x: x['R']):>7.3f}  {avg_all(lambda x: x['F1']):>7.3f}")
    print(f"{'=' * 70}")


if __name__ == "__main__":
    main()
