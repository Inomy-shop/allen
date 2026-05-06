import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import type { NodeDef, AgentDef, EngineEventEmitter } from './types.js';
import { renderTemplate } from './template.js';
import { extractOutputs, buildOutputInstruction } from './output-extractor.js';
import { buildToolCallRecord, type ToolCallRecord } from './tool-call.js';
import { withArtifactsGuidance, withNonInteractiveGuidance } from './agent-file-writer.js';
import { MCP_SERVER_NAME } from './brand.js';

/** Scratch dir when no worktree/repo is in scope. Never fall back to
 * process.cwd() — that's the engine's own source tree. */
const AGENT_FALLBACK_CWD = '/tmp/allen';

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
  toolCalls?: ToolCallRecord[];
}

interface PendingCodexTool {
  tool: string;
  args: Record<string, unknown>;
  startedAt: Date;
  startMs: number;
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
  feedbackContext?: string,
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
    // Only prepend system prompt on first run — resume already has context.
    // Append artifact guidance idempotently so Codex agents are told to save
    // generated deliverables via allen_save_artifact (the MCP tool is reachable
    // via the synced Codex config). Non-interactive guidance is layered on top
    // so codex workflow runs can't call ask_user / delegate_to_agent (no chat
    // surface to resolve them on).
    prompt = `${withNonInteractiveGuidance(withArtifactsGuidance(role.system))}\n\n${prompt}`;
  }
  prompt += buildOutputInstruction(nodeDef.outputs, nodeDef.output_format);
  if (nodeContext) {
    prompt += nodeContext;
  }
  if (feedbackContext) {
    prompt += feedbackContext;
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

  // Per-call MCP env overrides for the Allen MCP. Codex stores its MCP
  // entries with only the env vars passed at registration time and does
  // NOT forward its own runtime env to MCP children, so inheriting via
  // process.env is not enough. Without these `-c` overrides, the agent's
  // allen_save_artifact call returns "...artifact root is unknown..."
  // and no artifacts are created. Mirrors the chat-tools.ts spawn_agent
  // path (search: mcp_servers.${MCP_SERVER_NAME}.env).
  const escape = (v: string) => v.replace(/"/g, '\\"');
  const set = (k: string, v: string) =>
    ['-c', `mcp_servers.${MCP_SERVER_NAME}.env.${k}="${escape(v)}"`];
  const rootExecutionId = process.env.ALLEN_ROOT_EXECUTION_ID || executionId;
  const mcpEnvOverrides: string[] = [
    ...set('ALLEN_ARTIFACT_ROOT_TYPE', process.env.ALLEN_ARTIFACT_ROOT_TYPE || 'workflow'),
    ...set('ALLEN_ARTIFACT_ROOT_ID', process.env.ALLEN_ARTIFACT_ROOT_ID || rootExecutionId),
    ...set('ALLEN_ARTIFACT_NODE_NAME', nodeName),
    ...set('ALLEN_ARTIFACT_AGENT_NAME', nodeDef.agent ?? ''),
    ...set('ALLEN_ARTIFACT_AGENT_EXECUTION_ID', executionId),
    ...set('ALLEN_ARTIFACT_PARENT_ID', executionId),
    ...set('ALLEN_PARENT_EXECUTION_ID', executionId),
    ...set('ALLEN_ROOT_EXECUTION_ID', rootExecutionId),
    // Re-state the registration-time vars: in some Codex versions the -c
    // override replaces the env dict wholesale, so omitting these would
    // strip out ALLEN_API_URL / JWT_ACCESS_SECRET and break MCP auth.
    ...set('ALLEN_API_URL', `http://localhost:${process.env.PORT ?? '4023'}`),
    ...set('ALLEN_PUBLIC_URL', process.env.ALLEN_PUBLIC_URL || `http://localhost:${process.env.PORT ?? '4023'}`),
    ...set('JWT_ACCESS_SECRET', process.env.JWT_ACCESS_SECRET ?? ''),
  ];

  return new Promise<CodexResult>((resolve, reject) => {
    const args: string[] = ['exec'];

    if (isResume) {
      // Resume previous session
      args.push('resume', '--json', '--dangerously-bypass-approvals-and-sandbox');
      args.push(...mcpEnvOverrides);
      args.push(sessionId!, prompt);
    } else {
      // Fresh session — bypass approvals so MCP tools work
      args.push('--json', '--dangerously-bypass-approvals-and-sandbox');
      if (model && model !== 'default') {
        args.push('-c', `model="${model}"`);
      }
      if (codexEffort) {
        args.push('-c', `model_reasoning_effort="${codexEffort}"`);
      }
      args.push(...mcpEnvOverrides);
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
    const toolCalls: ToolCallRecord[] = [];
    const pendingTools = new Map<string, PendingCodexTool>();

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
            // Codex emits transient self-recovery events (MCP child-process
            // reconnects) as `event.type === 'error'` even though it then
            // succeeds. Logging those at level=error makes the UI flag
            // healthy runs as failed and pollutes rawResponse with
            // ERROR: lines that confuse downstream JSON extraction.
            const isTransient = /Reconnecting|timeout waiting for child process/i.test(errMsg);
            emitter.emit({
              event: 'execution_log',
              data: {
                executionId,
                timestamp: new Date(),
                level: isTransient ? 'warn' : 'error',
                category: 'agent',
                node: nodeName,
                message: `${isTransient ? 'Codex transient' : 'Codex error'}: ${errMsg}`,
              },
            });
            if (!isTransient) {
              rawResponse += `ERROR: ${errMsg}\n`;
            }
          }

          handleCodexEvent(event, nodeName, emitter, executionId, (text) => {
            rawResponse += text;
          }, toolCalls, pendingTools);
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

        // Flush any tool still marked pending (subprocess died mid-call).
        for (const [id, pending] of pendingTools) {
          toolCalls.push(buildToolCallRecord({
            tool: pending.tool,
            args: pending.args,
            durationMs: Date.now() - pending.startMs,
            startedAt: pending.startedAt,
            isError: true,
            toolUseId: id,
          }));
        }

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
          toolCalls,
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
  toolCalls: ToolCallRecord[],
  pendingTools: Map<string, PendingCodexTool>,
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

  // ── Bash / shell command ─────────────────────────────────────────────
  if (type === 'item.started' && item?.type === 'command_execution') {
    const cmd = item.command ?? 'unknown';
    pendingTools.set(item.id, {
      tool: 'Bash',
      args: { command: cmd },
      startedAt: new Date(),
      startMs: Date.now(),
    });
    emitter.emit({
      event: 'agent_tool_start',
      data: { node: nodeName, tool: 'Bash', args: { command: cmd }, toolUseId: item.id },
    });
    emitter.emit({
      event: 'execution_log',
      data: {
        executionId, timestamp: new Date(), level: 'info', category: 'tool',
        node: nodeName, message: `Running: ${cmd.slice(0, 150)}`,
      },
    });
  }
  if (type === 'item.completed' && item?.type === 'command_execution') {
    const pending = pendingTools.get(item.id);
    const startedAt = pending?.startedAt ?? new Date();
    const startMs = pending?.startMs ?? Date.now();
    const cmd = item.command ?? pending?.args.command ?? 'unknown';
    const output = item.aggregated_output ?? '';
    const isError = item.status !== 'completed';
    const record = buildToolCallRecord({
      tool: 'Bash',
      args: { command: cmd },
      result: output,
      durationMs: Date.now() - startMs,
      startedAt,
      isError,
      toolUseId: item.id,
    });
    toolCalls.push(record);
    pendingTools.delete(item.id);
    emitter.emit({
      event: 'agent_tool_complete',
      data: { node: nodeName, toolUseId: item.id, record },
    });
    emitter.emit({
      event: 'execution_log',
      data: {
        executionId, timestamp: new Date(),
        level: isError ? 'warn' : 'info', category: 'tool',
        node: nodeName,
        message: `${isError ? '✗' : '✓'} ${String(cmd).slice(0, 100)}${output ? ' → ' + String(output).slice(0, 100) : ''}`,
      },
    });
  }

  // ── MCP tool call (mcp__<server>__<tool>) ────────────────────────────
  if (type === 'item.started' && item?.type === 'mcp_tool_call') {
    const server = item.server ?? 'unknown';
    const fn = item.tool ?? 'call';
    const tool = `mcp__${server}__${fn}`;
    const args = (item.arguments && typeof item.arguments === 'object') ? item.arguments : {};
    pendingTools.set(item.id, { tool, args, startedAt: new Date(), startMs: Date.now() });
    emitter.emit({
      event: 'agent_tool_start',
      data: { node: nodeName, tool, args, toolUseId: item.id },
    });
  }
  if (type === 'item.completed' && item?.type === 'mcp_tool_call') {
    const pending = pendingTools.get(item.id);
    const startedAt = pending?.startedAt ?? new Date();
    const startMs = pending?.startMs ?? Date.now();
    const tool = pending?.tool ?? `mcp__${item.server ?? 'unknown'}__${item.tool ?? 'call'}`;
    const args = pending?.args ?? {};
    const resultText = Array.isArray(item.result?.content)
      ? item.result.content.map((c: any) => c.text ?? '').join('')
      : item.result;
    let resultData: unknown = resultText;
    if (typeof resultText === 'string') {
      try { resultData = JSON.parse(resultText); } catch { /* keep as string */ }
    }
    const isError = item.isError === true || item.error !== undefined;
    const record = buildToolCallRecord({
      tool, args, result: resultData,
      durationMs: Date.now() - startMs,
      startedAt,
      isError,
      toolUseId: item.id,
    });
    toolCalls.push(record);
    pendingTools.delete(item.id);
    emitter.emit({
      event: 'agent_tool_complete',
      data: { node: nodeName, toolUseId: item.id, record },
    });
  }

  // ── Function calls (OpenAI-style function/tool) ──────────────────────
  if (type === 'item.completed' && item?.type === 'function_call') {
    let args: Record<string, unknown> = {};
    try {
      args = typeof item.arguments === 'string' ? JSON.parse(item.arguments) : (item.arguments ?? {});
    } catch { args = { __raw__: String(item.arguments) }; }
    pendingTools.set(item.id, {
      tool: item.name ?? 'function',
      args,
      startedAt: new Date(),
      startMs: Date.now(),
    });
    emitter.emit({
      event: 'agent_tool_start',
      data: { node: nodeName, tool: item.name, args, toolUseId: item.id },
    });
  }
  if (type === 'item.completed' && item?.type === 'function_call_output') {
    // Paired with an earlier function_call via item.call_id (or id).
    const id = item.call_id ?? item.id;
    const pending = pendingTools.get(id);
    if (!pending) return;
    const record = buildToolCallRecord({
      tool: pending.tool,
      args: pending.args,
      result: item.output,
      durationMs: Date.now() - pending.startMs,
      startedAt: pending.startedAt,
      toolUseId: id,
    });
    toolCalls.push(record);
    pendingTools.delete(id);
    emitter.emit({
      event: 'agent_tool_complete',
      data: { node: nodeName, toolUseId: id, record },
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
