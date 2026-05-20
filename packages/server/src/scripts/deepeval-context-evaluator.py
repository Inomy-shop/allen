#!/usr/bin/env python3
"""Optional DeepEval sidecar for Allen context semantic evaluation.

The TypeScript server invokes this only when
ALLEN_CONTEXT_SEMANTIC_EVALUATOR=deepeval. DeepEval and evaluator-model
credentials are intentionally optional so workflow execution never depends on
Python packages being installed.
"""

import json
import hashlib
import hmac
import sys
import time
import urllib.error
import urllib.request


class AllenContextJudge:
    def __init__(self, judge_url, judge_secret, provider, model, timeout_ms):
        self.judge_url = str(judge_url or "")
        self.judge_secret = str(judge_secret or "").encode("utf-8")
        self.provider = str(provider or "codex")
        self.model = str(model or "gpt-5.5")
        self.timeout_s = max(1, int(timeout_ms or 300000) / 1000)
        self.last_response = {}

    def generate(self, prompt):
        body = json.dumps({
            "prompt": prompt,
            "provider": self.provider,
            "model": self.model,
        }, separators=(",", ":")).encode("utf-8")
        timestamp = str(int(time.time()))
        signature = hmac.new(self.judge_secret, timestamp.encode("utf-8") + b"." + body, hashlib.sha256).hexdigest()
        request = urllib.request.Request(
            self.judge_url,
            data=body,
            method="POST",
            headers={
                "content-type": "application/json",
                "x-allen-context-eval-timestamp": timestamp,
                "x-allen-context-eval-signature": signature,
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout_s) as response:
                payload = json.loads(response.read().decode("utf-8") or "{}")
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"Allen judge API failed with HTTP {exc.code}: {detail}") from exc
        self.last_response = payload if isinstance(payload, dict) else {}
        return str(payload.get("text") or "")


def safe_score(metric):
    try:
        return float(getattr(metric, "score", 0.0) or 0.0)
    except Exception:
        return 0.0


def metric_reason(metric):
    return str(getattr(metric, "reason", "") or "")


def parse_json_object(text):
    try:
        value = json.loads(text)
        if isinstance(value, dict):
            return value
    except Exception:
        pass
    start = text.find("{")
    end = text.rfind("}")
    if start >= 0 and end > start:
        value = json.loads(text[start : end + 1])
        if isinstance(value, dict):
            return value
    raise RuntimeError("Allen node context judge returned invalid JSON")


def build_judge_prompt(payload):
    evidence = {
        "nodeName": payload.get("nodeName"),
        "nodeRole": payload.get("nodeRole"),
        "retrievalProviders": payload.get("retrievalProviders"),
        "taskPrompt": payload.get("taskPrompt"),
        "finalOutput": payload.get("finalOutput"),
        "selectedRefs": payload.get("selectedRefs"),
        "injectableRefs": payload.get("injectableRefs"),
        "injectedRefs": payload.get("injectedRefs"),
        "providerNativeRefs": payload.get("providerNativeRefs"),
        "contextLifecycle": payload.get("contextLifecycle"),
        "sourceDiscoveryEvidence": payload.get("sourceDiscoveryEvidence"),
        "contextInjection": payload.get("contextInjection"),
        "usage": payload.get("usage"),
        "deterministic": payload.get("deterministic"),
        "feedbackEvidence": payload.get("feedbackEvidence"),
    }
    return "\n".join([
        "You are the node-level semantic evaluator for Allen context injection.",
        "Judge whether selected and injected repo context was precise, complete, useful, grounded, and not bloated for this specific node.",
        "Cognee refs are semantic recall candidates; do not assume Cognee results are relevant just because they were selected.",
        "Distinguish selectedRefs, injectableRefs, injectedRefs, provider-native refs, loaded refs, and applied refs.",
        "Provider-native refs such as .claude/CLAUDE.md for Claude agents and AGENTS.md for Codex agents are available through runtime startup when tracked as provider_native; do not penalize them for missing Allen full-body injection.",
        "Use contextLifecycle to verify Cognee refs. A Cognee ref is only verified as used when it was injected, provider-native, loaded, source-discovered where applicable, or backed by applied usage evidence.",
        "System-injected refs prove availability, not usefulness. Count a ref as useful only when usage or output evidence shows it affected the work.",
        "Respect injection policies such as snippet, manifest_only, mandatory_full, and never_full_auto.",
        "Context injection is for domain/spec guidance, repo practices, mandatory policies, and orientation.",
        "Investigation and implementation nodes should read concrete source files, tests, logs, diffs, and artifacts directly with tools.",
        "Do not penalize injection merely because source file bodies were not injected when sourceDiscoveryEvidence shows the agent inspected them.",
        "Do penalize missing guideline/spec/contract/domain context that should have been injected, and broad noisy Cognee docs that bloated the prompt.",
        "Return only valid JSON with this shape:",
        json.dumps({
            "scores": {
                "precision": 0,
                "completeness": 0,
                "usefulness": 0,
                "groundedness": 0,
                "correctness": 0,
                "bloat": 0,
                "overall": 0,
            },
            "diagnostics": [{
                "code": "short_machine_code",
                "severity": "info | warn",
                "message": "specific finding",
                "refIds": ["optional-ref-id"],
            }],
        }, indent=2),
        "Evidence JSON:",
        json.dumps(evidence, ensure_ascii=False, default=str)[:120000],
    ])


def main():
    payload = json.load(sys.stdin)
    judge_url = str(payload.get("judgeUrl") or "")
    judge_secret = str(payload.get("judgeSecret") or "")
    if judge_url and judge_secret:
        judge = AllenContextJudge(
            judge_url,
            judge_secret,
            payload.get("provider") or "codex",
            payload.get("model") or "gpt-5.5",
            payload.get("timeoutMs") or 300000,
        )
        text = judge.generate(build_judge_prompt(payload))
        result = parse_json_object(text)
        result.setdefault("provider", "deepeval")
        result.setdefault("runner", "allen_node_context_judge")
        result.setdefault("modelProvider", f"allen_{judge.provider}")
        result.setdefault("model", f"allen-{judge.provider}/{judge.model}")
        result.setdefault("rawJudgeResponse", text)
        result.setdefault("judgeProvider", judge.last_response.get("provider"))
        result.setdefault("judgeModel", judge.last_response.get("model"))
        result.setdefault("judgeDurationMs", judge.last_response.get("durationMs"))
        result.setdefault("judgeCostUsd", judge.last_response.get("costUsd"))
        print(json.dumps(result))
        return

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
