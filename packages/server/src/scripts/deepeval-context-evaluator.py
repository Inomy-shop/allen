#!/usr/bin/env python3
"""Optional DeepEval sidecar for Allen context semantic evaluation.

The TypeScript server invokes this only when
ALLEN_CONTEXT_SEMANTIC_EVALUATOR=deepeval. DeepEval and evaluator-model
credentials are intentionally optional so workflow execution never depends on
Python packages being installed.
"""

import json
import sys


def safe_score(metric):
    try:
        return float(getattr(metric, "score", 0.0) or 0.0)
    except Exception:
        return 0.0


def metric_reason(metric):
    return str(getattr(metric, "reason", "") or "")


def main():
    payload = json.load(sys.stdin)
    try:
        from deepeval.test_case import LLMTestCase
        from deepeval.metrics import (
            AnswerRelevancyMetric,
            ContextualRelevancyMetric,
            FaithfulnessMetric,
        )
    except Exception as exc:
        raise SystemExit(f"DeepEval is not installed or failed to import: {exc}")

    task = str(payload.get("taskPrompt") or "")
    output = str(payload.get("finalOutput") or "")
    selected = payload.get("selectedRefs") if isinstance(payload.get("selectedRefs"), list) else []
    injected = payload.get("injectedRefs") if isinstance(payload.get("injectedRefs"), list) else []
    contexts = []
    for ref in injected or selected:
        if not isinstance(ref, dict):
            continue
        body = ref.get("content") or ref.get("body") or ref.get("summary") or ref.get("title")
        if body:
            contexts.append(str(body)[:12000])
    if not contexts:
        contexts = [json.dumps(selected[:12])[:12000]]

    test_case = LLMTestCase(
        input=task or "Evaluate whether the workflow node output used the supplied repo context correctly.",
        actual_output=output or "",
        retrieval_context=contexts,
    )

    metrics = {
        "response_relevance": AnswerRelevancyMetric(),
        "context_precision": ContextualRelevancyMetric(),
        "groundedness": FaithfulnessMetric(),
    }
    diagnostics = []
    scores = {}
    for name, metric in metrics.items():
        metric.measure(test_case)
        scores[name] = safe_score(metric)
        reason = metric_reason(metric)
        if reason:
            diagnostics.append({
                "code": f"deepeval_{name}",
                "severity": "info",
                "message": reason[:1000],
            })

    # Map semantic metric names into Allen's common score slots where possible.
    mapped = {
        "precision": scores.get("context_precision"),
        "groundedness": scores.get("groundedness"),
        "usefulness": scores.get("response_relevance"),
    }
    print(json.dumps({"scores": mapped, "rawScores": scores, "diagnostics": diagnostics}))


if __name__ == "__main__":
    main()
