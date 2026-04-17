import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import type { NodeDef, AgentDef, EngineEventEmitter } from './types.js';
import { renderTemplate } from './template.js';
import { extractOutputs, buildOutputInstruction } from './output-extractor.js';

/** Scratch dir when no worktree/repo is in scope. Never fall back to
 * process.cwd() — that's the engine's own source tree. */
const AGENT_FALLBACK_CWD = '/tmp/flowforge';

interface CodexResult {
  outputs: Record<string, unknown>;
  rawResponse: string;
  sessionId?: string;
  cost: {
    actual: number | null;
    estimated: number;
    model: string;
    turns: number;
    method: 'sdk_reported' | 'estimated';
  };
  durationMs: number;
}

/**
 * Execute an agent node using OpenAI Codex CLI (`codex exec --json`).
 * Spawns codex as a subprocess and parses JSONL output.
 */
export async function executeCodexNode(
  nodeName: string,
  nodeDef: NodeDef,
  state: Record<string, unknown>,
  role: AgentDef | undefined,
  emitter: EngineEventEmitter,
  executionId: string,
  sessionId?: string,
  nodeContext?: string,
  abortSignal?: AbortSignal,
): Promise<CodexResult> {
  const start = Date.now();
  // Apply per-node overrides first, then agent defaults.
  const override = nodeDef.agentOverrides ?? {};
  const model = (override.model ?? role?.model) ?? 'default';
  const reasoningEffort = (override.reasoningEffort ?? role?.reasoningEffort) ?? undefined;
  // Codex doesn't support 'max' — clamp to 'high'. 'off' means "don't emit".
  const codexEffort =
    reasoningEffort && reasoningEffort !== 'off'
      ? reasoningEffort === 'max'
        ? 'high'
        : reasoningEffort
      : undefined;
  // Resume by default unless explicitly disabled on the node
  const isResume = !!((nodeDef.resume_on_retry !== false) && sessionId);

  let prompt = nodeDef.prompt ? renderTemplate(nodeDef.prompt, state) : '';
  if (!isResume && role?.system) {
    // Only prepend system prompt on first run — resume already has context
    prompt = `${role.system}\n\n${prompt}`;
  }
  prompt += buildOutputInstruction(nodeDef.outputs, nodeDef.output_format);
  if (nodeContext) {
    prompt += nodeContext;
  }

  emitter.emit({
    event: 'node_started',
    data: { node: nodeName, agent: nodeDef.agent, attempt: 1 },
  });

  emitter.emit({
    event: 'execution_log',
    data: {
      executionId,
      timestamp: new Date(),
      level: 'info',
      category: 'system',
      node: nodeName,
      message: `Node started (provider: codex, model: ${model}${isResume ? ', resuming session ' + sessionId : ''})`,
    },
  });

  const cwd = (state.worktree_path as string) ?? (state.repo_path as string) ?? AGENT_FALLBACK_CWD;
  mkdirSync(cwd, { recursive: true });

  return new Promise<CodexResult>((resolve, reject) => {
    const args: string[] = ['exec'];

    if (isResume) {
      // Resume previous session
      args.push('resume', '--json', '--dangerously-bypass-approvals-and-sandbox', sessionId!, prompt);
    } else {
      // Fresh session — bypass approvals so MCP tools work
      args.push('--json', '--dangerously-bypass-approvals-and-sandbox');
      if (model && model !== 'default') {
        args.push('-c', `model="${model}"`);
      }
      if (codexEffort) {
        args.push('-c', `model_reasoning_effort="${codexEffort}"`);
      }
      args.push(prompt);
    }

    const proc = spawn('codex', args, {
      cwd,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Close stdin immediately so codex doesn't wait for input
    proc.stdin.end();

    // Kill process on abort signal (cancel)
    if (abortSignal) {
      if (abortSignal.aborted) { proc.kill('SIGTERM'); reject(new Error('Execution cancelled')); return; }
      abortSignal.addEventListener('abort', () => { try { proc.kill('SIGTERM'); } catch {} }, { once: true });
    }

    let rawResponse = '';
    let turns = 0;
    let threadId: string | undefined = isResume ? sessionId : undefined;

    // Parse JSONL from stdout
    let lineBuffer = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      lineBuffer += chunk.toString();
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          // Capture thread ID for session resume
          if (event.type === 'thread.started' && event.thread_id) {
            threadId = event.thread_id;
          }

          // Check for error events
          if (event.type === 'error' || event.type === 'turn.failed') {
            const errMsg = event.message ?? event.error?.message ?? JSON.stringify(event);
            emitter.emit({
              event: 'execution_log',
              data: {
                executionId,
                timestamp: new Date(),
                level: 'error',
                category: 'agent',
                node: nodeName,
                message: `Codex error: ${errMsg}`,
              },
            });
            rawResponse += `ERROR: ${errMsg}\n`;
          }

          handleCodexEvent(event, nodeName, emitter, executionId, (text) => {
            rawResponse += text;
          });
          if (event.type === 'turn.completed') {
            turns++;
          }
        } catch {
          // Not JSON — treat as raw text
          rawResponse += line + '\n';
          emitter.emit({
            event: 'agent_text',
            data: { node: nodeName, text: line + '\n' },
          });
        }
      }
    });

    let stderrText = '';
    proc.stderr.on('data', (chunk: Buffer) => {
      stderrText += chunk.toString();
    });

    proc.on('close', async (code) => {


      // Process any remaining buffer
      if (lineBuffer.trim()) {
        rawResponse += lineBuffer;
      }

      if (code !== 0 && !rawResponse) {
        reject(new Error(`Codex process exited with code ${code}: ${stderrText.slice(0, 500)}`));
        return;
      }
      // If rawResponse only contains errors, still fail
      if (code !== 0 && rawResponse.startsWith('ERROR:')) {
        reject(new Error(rawResponse.slice(0, 500)));
        return;
      }

      try {
        const extractLog = (msg: string) => emitter.emit({
          event: 'execution_log',
          data: { executionId, timestamp: new Date(), level: 'debug', category: 'system', node: nodeName, message: `[extraction] ${msg}` },
        });
        const outputs = await extractOutputs(rawResponse, nodeDef, extractLog);

        emitter.emit({
          event: 'execution_log',
          data: {
            executionId,
            timestamp: new Date(),
            level: 'info',
            category: 'system',
            node: nodeName,
            message: `Outputs extracted: ${Object.keys(outputs).join(', ') || 'none'}`,
          },
        });

        resolve({
          outputs,
          rawResponse,
          sessionId: threadId,
          cost: {
            actual: null,
            estimated: 0.02 * Math.max(turns, 1),
            model,
            turns: Math.max(turns, 1),
            method: 'estimated',
          },
          durationMs: Date.now() - start,
        });
      } catch (err: unknown) {
        reject(err);
      }
    });

    proc.on('error', (err) => {

      reject(new Error(`Failed to spawn codex: ${err.message}`));
    });
  });
}

function handleCodexEvent(
  event: any,
  nodeName: string,
  emitter: EngineEventEmitter,
  executionId: string,
  appendText: (text: string) => void,
) {
  const type = event.type;
  const item = event.item;

  // Agent text message
  if (type === 'item.completed' && item?.type === 'agent_message' && item.text) {
    appendText(item.text);
    emitter.emit({
      event: 'agent_text',
      data: { node: nodeName, text: item.text },
    });
    emitter.emit({
      event: 'execution_log',
      data: {
        executionId,
        timestamp: new Date(),
        level: 'info',
        category: 'agent',
        node: nodeName,
        message: item.text.slice(0, 200),
      },
    });
  }

  // Command/tool started
  if (type === 'item.started' && item?.type === 'command_execution') {
    const cmd = item.command ?? 'unknown';
    emitter.emit({
      event: 'agent_tool_start',
      data: { node: nodeName, tool: 'shell', args: { command: cmd } },
    });
    emitter.emit({
      event: 'execution_log',
      data: {
        executionId,
        timestamp: new Date(),
        level: 'info',
        category: 'tool',
        node: nodeName,
        message: `Running: ${cmd.slice(0, 150)}`,
      },
    });
  }

  // Command/tool completed
  if (type === 'item.completed' && item?.type === 'command_execution') {
    const cmd = item.command ?? 'unknown';
    const output = item.aggregated_output ?? '';
    const status = item.status === 'completed' ? 'completed' : 'failed';
    emitter.emit({
      event: 'agent_tool_complete',
      data: { node: nodeName, tool: 'shell', summary: `${status}: ${cmd.slice(0, 80)}` },
    });
    emitter.emit({
      event: 'execution_log',
      data: {
        executionId,
        timestamp: new Date(),
        level: status === 'failed' ? 'warn' : 'info',
        category: 'tool',
        node: nodeName,
        message: `${status === 'failed' ? '✗' : '✓'} ${cmd.slice(0, 100)}${output ? ' → ' + output.slice(0, 100) : ''}`,
      },
    });
  }

  // Turn completed — usage info
  if (type === 'turn.completed' && event.usage) {
    emitter.emit({
      event: 'execution_log',
      data: {
        executionId,
        timestamp: new Date(),
        level: 'info',
        category: 'system',
        node: nodeName,
        message: `Tokens: ${event.usage.input_tokens} in, ${event.usage.output_tokens} out (${event.usage.cached_input_tokens ?? 0} cached)`,
      },
    });
  }
}
