#!/bin/bash
# Test the learning system
# Usage: bash scripts/test-learnings.sh

API="http://localhost:4023"

echo "=== FlowForge Learning System Test ==="
echo ""

# Check server
curl -s $API/api/health > /dev/null || { echo "Server not running on $API"; exit 1; }

# Helper: count learnings
count_learnings() {
  node -e "
    const { MongoClient } = require('mongodb');
    async function main() {
      const client = new MongoClient('mongodb://localhost:27017/flowforge');
      await client.connect();
      const count = await client.db().collection('learnings').countDocuments({status:'active'});
      console.log(count);
      client.close();
    }
    main();
  " 2>/dev/null
}

# Helper: show learnings
show_learnings() {
  node -e "
    const { MongoClient } = require('mongodb');
    async function main() {
      const client = new MongoClient('mongodb://localhost:27017/flowforge');
      await client.connect();
      const learnings = await client.db().collection('learnings').find({status:'active'}).sort({createdAt:-1}).limit(10).toArray();
      for (const l of learnings) {
        console.log('  [' + l.type + ', ' + l.scope.level + '] ' + l.content.slice(0, 120));
        console.log('    confidence: ' + l.confidence + ' | source: ' + l.source.sourceType + ' | tokens: ' + l.tokenCount);
      }
      if (learnings.length === 0) console.log('  (none)');
      client.close();
    }
    main();
  " 2>/dev/null
}

# Helper: show execution logs for learning-related entries
show_learning_logs() {
  local EXEC_ID=$1
  curl -s "$API/api/executions/$EXEC_ID/logs?limit=100" 2>/dev/null | node -e "
    const logs=JSON.parse(require('fs').readFileSync(0,'utf8'));
    logs.filter(l => l.message.includes('[learning]') || l.message.includes('Learning') || l.category === 'gate').forEach(l => {
      const ts = new Date(l.timestamp).toLocaleTimeString('en-US', {hour12:false});
      console.log('  ' + ts + ' ' + l.category + ' [' + (l.node ?? '') + '] ' + l.message.slice(0, 150));
    });
  " 2>/dev/null
}

echo "Step 1: Check current learnings"
BEFORE=$(count_learnings)
echo "Active learnings before: $BEFORE"
echo ""

echo "Step 2: Run a workflow (this will create learnings)"
echo "Go to the FlowForge UI and run one of these:"
echo ""
echo "  Option A: Run 'smart-answer' with question 'asdfghjkl'"
echo "    → Tests: auto-gate stop → creates a 'fact' learning"
echo ""
echo "  Option B: Run 'email-drafter' with context 'draft an email'"
echo "    → Tests: clarify → human correction → creates a 'preference' learning"
echo ""
echo "  Option C: Run 'qa-with-judge' with any question"
echo "    → Tests: normal flow → if judge rejects → retry delta learning"
echo ""
read -p "Press Enter after running a workflow..."
echo ""

echo "Step 3: Check learnings after execution"
AFTER=$(count_learnings)
echo "Active learnings after: $AFTER (was $BEFORE)"
NEW=$((AFTER - BEFORE))
echo "New learnings created: $NEW"
echo ""

echo "Step 4: Show all active learnings"
show_learnings
echo ""

echo "Step 5: Check latest execution's learning logs"
LATEST_ID=$(curl -s $API/api/executions 2>/dev/null | node -e "const e=JSON.parse(require('fs').readFileSync(0,'utf8'));console.log(e[0]?.id ?? '')" 2>/dev/null)
if [ -n "$LATEST_ID" ]; then
  echo "Execution: $LATEST_ID"
  show_learning_logs "$LATEST_ID"
else
  echo "No executions found"
fi
echo ""

echo "Step 6: Run the SAME workflow again to test injection"
echo "Run the same workflow with the same or similar input."
read -p "Press Enter after running again..."
echo ""

echo "Step 7: Check if learnings were injected"
LATEST_ID2=$(curl -s $API/api/executions 2>/dev/null | node -e "const e=JSON.parse(require('fs').readFileSync(0,'utf8'));console.log(e[0]?.id ?? '')" 2>/dev/null)
if [ -n "$LATEST_ID2" ]; then
  echo "Execution: $LATEST_ID2"
  echo "Learning logs:"
  show_learning_logs "$LATEST_ID2"
fi
echo ""

echo "Step 8: Final learning count"
FINAL=$(count_learnings)
echo "Active learnings: $FINAL"
show_learnings
echo ""
echo "=== Test Complete ==="
