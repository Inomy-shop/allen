#!/bin/bash
# Test which Codex models work with the current account
# Usage: bash scripts/test-codex-models.sh

PROMPT="Reply with exactly: HELLO"
TIMEOUT=30

MODELS=(
  "default"
  "gpt-4o"
  "gpt-4o-mini"
  "gpt-4.1"
  "gpt-4.1-mini"
  "gpt-4.1-nano"
  "gpt-5"
  "gpt-5-mini"
  "gpt-5.4"
  "o3"
  "o3-mini"
  "o3-pro"
  "o4-mini"
  "codex-mini"
)

echo "================================================"
echo "  Codex Model Compatibility Test"
echo "  Account default model: $(grep '^model' ~/.codex/config.toml 2>/dev/null | head -1)"
echo "================================================"
echo ""

PASSED=0
FAILED=0
ERRORS=()

for model in "${MODELS[@]}"; do
  printf "%-20s " "$model"

  if [ "$model" = "default" ]; then
    OUTPUT=$(timeout $TIMEOUT codex exec --json --full-auto "$PROMPT" 2>&1)
  else
    OUTPUT=$(timeout $TIMEOUT codex exec --json --full-auto -c "model=\"$model\"" "$PROMPT" 2>&1)
  fi

  EXIT_CODE=$?

  # Check for errors in JSONL
  if echo "$OUTPUT" | grep -q '"type":"error"'; then
    ERROR_MSG=$(echo "$OUTPUT" | grep '"type":"error"' | head -1 | sed 's/.*"message":"\([^"]*\)".*/\1/' | head -c 80)
    echo "❌ FAIL — $ERROR_MSG"
    FAILED=$((FAILED + 1))
    ERRORS+=("$model: $ERROR_MSG")
  elif echo "$OUTPUT" | grep -q '"type":"turn.failed"'; then
    ERROR_MSG=$(echo "$OUTPUT" | grep '"type":"turn.failed"' | head -1 | sed 's/.*"message":"\([^"]*\)".*/\1/' | head -c 80)
    echo "❌ FAIL — $ERROR_MSG"
    FAILED=$((FAILED + 1))
    ERRORS+=("$model: $ERROR_MSG")
  elif [ $EXIT_CODE -eq 124 ]; then
    echo "⏱  TIMEOUT (${TIMEOUT}s)"
    FAILED=$((FAILED + 1))
    ERRORS+=("$model: timeout")
  elif [ $EXIT_CODE -ne 0 ]; then
    echo "❌ FAIL — exit code $EXIT_CODE"
    FAILED=$((FAILED + 1))
    ERRORS+=("$model: exit code $EXIT_CODE")
  elif echo "$OUTPUT" | grep -qi "HELLO"; then
    echo "✅ PASS"
    PASSED=$((PASSED + 1))
  else
    echo "⚠️  RESPONSE (no HELLO found, but no error)"
    PASSED=$((PASSED + 1))
  fi
done

echo ""
echo "================================================"
echo "  Results: $PASSED passed, $FAILED failed"
echo "================================================"

if [ ${#ERRORS[@]} -gt 0 ]; then
  echo ""
  echo "Failed models:"
  for err in "${ERRORS[@]}"; do
    echo "  ✗ $err"
  done
fi

echo ""
echo "Working models can be used in roles.yml as:"
echo '  model: <model-name>'
echo '  provider: codex'
