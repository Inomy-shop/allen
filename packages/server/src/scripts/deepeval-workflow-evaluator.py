#!/usr/bin/env python3
"""Workflow-level DeepEval runner for Allen context quality evaluation.

Input is a JSON object on stdin:
  {
    "prompt": "...",
    "judgeUrl": "http://127.0.0.1:4000/api/internal/context-evaluation/judge",
    "judgeSecret": "...",
    "provider": "codex",
    "model": "gpt-5.5",
    "timeoutMs": 300000
  }

The sidecar imports DeepEval so the workflow evaluation is owned by the
DeepEval provider path, while the actual LLM call is routed back through
Allen's internal judge endpoint. That keeps credentials/model routing inside
Allen and avoids requiring DeepEval-managed OpenAI credentials.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import sys
import time
import urllib.error
import urllib.request
from typing import Any, Dict, Optional


class AllenDeepEvalJudge:
    """DeepEval-compatible LLM adapter backed by Allen's internal judge API."""

    def __init__(self, judge_url: str, judge_secret: str, provider: str, model: str, timeout_ms: int) -> None:
        self.judge_url = judge_url
        self.judge_secret = judge_secret.encode("utf-8")
        self.provider = provider
        self.model = model
        self.timeout_s = max(1, timeout_ms / 1000)
        self.last_response: Dict[str, Any] = {}

    def load_model(self) -> "AllenDeepEvalJudge":
        return self

    def get_model_name(self) -> str:
        return f"allen-{self.provider}/{self.model}"

    def generate(self, prompt: str, schema: Optional[Any] = None) -> Any:
        body = json.dumps({"prompt": prompt, "provider": self.provider, "model": self.model}, separators=(",", ":")).encode("utf-8")
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
        text = str(payload.get("text") or "")
        if schema is not None and hasattr(schema, "model_validate_json"):
            return schema.model_validate_json(text)
        return text

    async def a_generate(self, prompt: str, schema: Optional[Any] = None) -> Any:
        return await asyncio.to_thread(self.generate, prompt, schema)


def parse_json_object(text: str) -> Dict[str, Any]:
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
    raise RuntimeError("Allen workflow judge returned invalid JSON")


def main() -> None:
    payload = json.load(sys.stdin)
    prompt = str(payload.get("prompt") or "")
    judge_url = str(payload.get("judgeUrl") or "")
    judge_secret = str(payload.get("judgeSecret") or "")
    provider = str(payload.get("provider") or "codex")
    model = str(payload.get("model") or "gpt-5.5")
    timeout_ms = int(payload.get("timeoutMs") or 300000)
    if not prompt or not judge_url or not judge_secret:
        raise SystemExit("prompt, judgeUrl, and judgeSecret are required")

    judge = AllenDeepEvalJudge(judge_url, judge_secret, provider, model, timeout_ms)
    text = judge.generate(prompt)
    result = parse_json_object(text)
    result.setdefault("provider", "deepeval")
    result.setdefault("runner", "python_deepeval")
    result.setdefault("modelProvider", f"allen_{provider}")
    result.setdefault("model", judge.get_model_name())
    result.setdefault("rawJudgeResponse", text)
    result.setdefault("judgeProvider", judge.last_response.get("provider"))
    result.setdefault("judgeModel", judge.last_response.get("model"))
    result.setdefault("judgeDurationMs", judge.last_response.get("durationMs"))
    result.setdefault("judgeCostUsd", judge.last_response.get("costUsd"))
    print(json.dumps(result))


if __name__ == "__main__":
    main()
