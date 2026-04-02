/**
 * Monaco editor YAML completion suggestions for FlowForge workflow schema.
 */
import type { languages } from 'monaco-editor';

type CompletionItem = languages.CompletionItem;

const topLevelKeys = [
  { label: 'name', detail: 'Workflow name', insertText: 'name: ' },
  { label: 'description', detail: 'Workflow description', insertText: 'description: ' },
  { label: 'version', detail: 'Version number', insertText: 'version: 1' },
  { label: 'context', detail: 'Workflow context', insertText: 'context:\n  requires: []\n  tools: []\n  concurrency: 1' },
  { label: 'input', detail: 'Input schema', insertText: 'input:\n  task: { type: string, required: true }' },
  { label: 'nodes', detail: 'Workflow nodes', insertText: 'nodes:\n  ' },
  { label: 'edges', detail: 'Workflow edges', insertText: 'edges:\n  - { from: START, to:  }' },
];

const nodeProperties = [
  { label: 'role', detail: 'Agent role name', insertText: 'role: ' },
  { label: 'prompt', detail: 'Node prompt template', insertText: 'prompt: |\n    ' },
  { label: 'type', detail: 'Node type', insertText: 'type: ' },
  { label: 'outputs', detail: 'Output field names', insertText: 'outputs: []' },
  { label: 'output_format', detail: 'json | freeform', insertText: 'output_format: json' },
  { label: 'resume_on_retry', detail: 'Reuse Claude session', insertText: 'resume_on_retry: true' },
  { label: 'timeout', detail: 'Timeout in seconds', insertText: 'timeout: 300' },
  { label: 'function', detail: 'Built-in function name', insertText: 'function: ' },
  { label: 'config', detail: 'Function config', insertText: 'config:\n    ' },
  { label: 'workflow', detail: 'Sub-workflow name', insertText: 'workflow: ' },
  { label: 'input_map', detail: 'Parent→child mapping', insertText: 'input_map:\n    ' },
  { label: 'output_map', detail: 'Child→parent mapping', insertText: 'output_map:\n    ' },
  { label: 'fields', detail: 'Human input fields', insertText: 'fields:\n    - { name: , type: string, label: "" }' },
  { label: 'conditions', detail: 'Condition definitions', insertText: 'conditions:\n    - name: \n      expression: ""' },
  { label: 'retries', detail: 'Max retries for code nodes', insertText: 'retries: 2' },
  { label: 'backoff', detail: 'exponential | linear | fixed', insertText: 'backoff: exponential' },
  { label: 'on_failure', detail: 'fail | skip | fallback', insertText: 'on_failure: fail' },
];

const edgeProperties = [
  { label: 'from', detail: 'Source node(s)', insertText: 'from: ' },
  { label: 'to', detail: 'Target node(s)', insertText: 'to: ' },
  { label: 'condition', detail: 'Edge condition expression', insertText: 'condition: ""' },
  { label: 'parallel', detail: 'Fork to parallel branches', insertText: 'parallel: true' },
  { label: 'join', detail: 'wait-all | wait-any | fail-fast', insertText: 'join: wait-all' },
  { label: 'max_retries', detail: 'Max retries for backward edge', insertText: 'max_retries: 3' },
  { label: 'retry_context', detail: 'Context template for retries', insertText: 'retry_context: "{{}}"\n' },
  { label: 'merge', detail: 'Parallel merge strategies', insertText: 'merge:\n      ' },
];

const nodeTypes = ['agent', 'code', 'human', 'workflow', 'condition'];
const roles = ['planner', 'developer', 'tester', 'reviewer', 'researcher', 'writer', 'editor', 'analyst', 'investigator', 'git-ops', 'formatter'];
const builtIns = ['git-create-branch', 'git-commit', 'git-push', 'git-create-pr', 'git-cleanup-worktree', 'run-build', 'run-tests', 'classify-task'];

export function registerYamlCompletions(monaco: any): void {
  monaco.languages.registerCompletionItemProvider('yaml', {
    provideCompletionItems(model: any, position: any) {
      const line = model.getLineContent(position.lineNumber);
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };

      const indent = line.search(/\S|$/);
      let suggestions: Partial<CompletionItem>[];

      if (indent === 0) {
        suggestions = topLevelKeys;
      } else if (line.includes('type:')) {
        suggestions = nodeTypes.map(t => ({ label: t, insertText: t }));
      } else if (line.includes('role:')) {
        suggestions = roles.map(r => ({ label: r, insertText: r }));
      } else if (line.includes('function:')) {
        suggestions = builtIns.map(b => ({ label: b, insertText: b }));
      } else if (indent <= 4) {
        suggestions = nodeProperties;
      } else {
        suggestions = [...edgeProperties, ...nodeProperties];
      }

      return {
        suggestions: suggestions.map((s, i) => ({
          label: s.label!,
          kind: monaco.languages.CompletionItemKind.Property,
          insertText: s.insertText ?? s.label,
          detail: (s as any).detail ?? '',
          range,
          sortText: String(i).padStart(3, '0'),
        })),
      };
    },
  });
}
