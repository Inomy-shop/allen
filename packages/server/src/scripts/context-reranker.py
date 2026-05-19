#!/usr/bin/env python3
"""Optional Allen context reranker sidecar.

This script is intentionally optional. Allen falls back to deterministic
ranking when the requested Python package is unavailable.
"""

import json
import os
import sys


def candidate_text(candidate):
    return "\n".join(
        str(candidate.get(key) or "")
        for key in ("title", "path", "kind", "summary", "content")
    ) + "\n" + " ".join(candidate.get("tags") or [])


def rerank_with_flashrank(payload):
    from flashrank import Ranker, RerankRequest

    ranker = Ranker()
    passages = [
        {"id": c["refId"], "text": candidate_text(c), "meta": c}
        for c in payload.get("candidates", [])
        if c.get("refId")
    ]
    request = RerankRequest(query=payload.get("task", ""), passages=passages)
    rows = ranker.rerank(request)
    return [
        {
            "refId": row.get("id") or (row.get("meta") or {}).get("refId"),
            "score": float(row.get("score", 0)),
            "reason": "FlashRank query-document relevance score.",
        }
        for row in rows
    ]


def rerank_with_sentence_transformers(payload, model_name):
    from sentence_transformers import CrossEncoder

    model = CrossEncoder(model_name)
    candidates = [c for c in payload.get("candidates", []) if c.get("refId")]
    pairs = [(payload.get("task", ""), candidate_text(c)) for c in candidates]
    scores = model.predict(pairs) if pairs else []
    return [
        {
            "refId": candidate["refId"],
            "score": float(score),
            "reason": f"{model_name} query-document relevance score.",
        }
        for candidate, score in zip(candidates, scores)
    ]


def main():
    payload = json.loads(sys.stdin.read() or "{}")
    provider_id = payload.get("providerId") or os.getenv("ALLEN_CONTEXT_RERANKER") or "bge"
    if provider_id == "flashrank":
        scores = rerank_with_flashrank(payload)
    else:
        model_name = os.getenv("ALLEN_CONTEXT_RERANKER_MODEL") or "BAAI/bge-reranker-base"
        scores = rerank_with_sentence_transformers(payload, model_name)
    print(json.dumps({"scores": scores, "diagnostics": []}))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
