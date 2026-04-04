/**
 * Chat LLM Backend
 * Uses Claude Code SDK (CLI auth — no API key needed) with prompt-based tool calling.
 * Claude outputs <tool_call> JSON blocks, server parses + executes them, injects results,
 * and resumes the conversation in the same session.
 */

import type { Db } from 'mongodb';
import { chatTools, executeChatTool } from './chat-tools.js';

// ── Types ──

export interface ChatLLMMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatLLMOptions {
  model?: string;
  systemPrompt: string;
  messages: ChatLLMMessage[];
  onText: (text: string) => void;
  onThinking?: (thinking: string) => void;
  onToolStart: (tool: string, args: Record<string, unknown>, toolUseId: string) => void;
  onToolResult: (tool: string, result: Record<string, unknown>, toolUseId: string, durationMs: number) => void;
  skipTools?: boolean;
  signal?: AbortSignal;
}

export interface ChatLLMResult {
  text: string;
  costUsd: number;
  durationMs: number;
  model: string;
  sessionId?: string;
}

// ── Tool Call Protocol ──

/**
 * Build the tool-calling instructions appended to the system prompt.
 * Claude is instructed to output <tool_call> JSON blocks when it wants to use a tool.
 */
function buildToolInstructions(): string {
  const toolDefs = chatTools.map(t => {
    const params = (t.inputSchema as any).properties ?? {};
    const required = (t.inputSchema as any).required ?? [];
    const paramList = Object.entries(params)
      .map(([k, v]: [string, any]) => `    "${k}": ${v.description ?? v.type}${required.includes(k) ? ' (required)' : ''}`)
      .join('\n');
    return `- **${t.name}**: ${t.description}\n  Parameters:\n${paramList || '    (none)'}`;
  }).join('\n\n');

  return `

## Tool Calling

You have access to tools. To call a tool, output a <tool_call> block in your response:

<tool_call>
{"tool": "tool_name", "args": {"param1": "value1"}}
</tool_call>

After you output a <tool_call>, the system will execute it and provide the result in a <tool_result> block. You can then continue your response using that information.

You may call multiple tools in sequence. Wait for each result before calling the next.

Available tools:

${toolDefs}

IMPORTANT: Only use <tool_call> blocks to invoke tools. Do NOT describe what you would do — actually call the tool.`;
}

/** Parse <tool_call> blocks from text. Returns the tool call and the text before/after. */
function parseToolCalls(text: string): { beforeText: string; toolCall: { tool: string; args: Record<string, unknown> } | null; afterText: string } {
  const match = text.match(/<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/);
  if (!match) return { beforeText: text, toolCall: null, afterText: '' };

  const beforeText = text.slice(0, match.index!);
  const afterText = text.slice(match.index! + match[0].length);

  try {
    const parsed = JSON.parse(match[1]);
    return { beforeText, toolCall: { tool: parsed.tool, args: parsed.args ?? {} }, afterText };
  } catch {
    return { beforeText: text, toolCall: null, afterText: '' };
  }
}

/** Strip all <tool_call>...</tool_call> and <tool_result>...</tool_result> blocks from final display text. */
function cleanDisplayText(text: string): string {
  return text
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
    .replace(/<tool_result>[\s\S]*?<\/tool_result>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── Main Function ──

/**
 * Run a chat conversation using Claude Code SDK with prompt-based tool calling.
 * - First call: sends prompt with tool instructions, gets response
 * - If response contains <tool_call>: execute tool, resume conversation with result
 * - Loop until no more tool calls or max rounds reached
 */
export async function runChatLLM(
  db: Db,
  options: ChatLLMOptions,
): Promise<ChatLLMResult> {
  const { query } = await import('@anthropic-ai/claude-code');

  const model = options.model ?? 'sonnet';
  const systemPrompt = options.skipTools
    ? options.systemPrompt
    : options.systemPrompt + buildToolInstructions();

  // Build the initial prompt from conversation history
  // Claude Code SDK doesn't take a messages array — it takes a single prompt string.
  // We reconstruct the conversation as a prompt.
  let conversationPrompt = '';
  for (const msg of options.messages) {
    if (msg.role === 'user') {
      conversationPrompt += msg.content + '\n';
    }
    // Skip assistant messages in prompt reconstruction — Claude Code handles its own context via session resume
  }

  let claudeSessionId: string | undefined;
  let totalCost = 0;
  let totalDuration = 0;
  let fullDisplayText = '';
  let toolCallCount = 0;

  const MAX_TOOL_ROUNDS = 10;

  // Initial prompt is the last user message (the conversation history was for the Messages API approach)
  const lastUserMsg = options.messages.length > 0
    ? options.messages[options.messages.length - 1].content
    : '';

  let currentPrompt = lastUserMsg;

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    if (options.signal?.aborted) break;

    let rawResponse = '';
    let sessionId: string | undefined;
    let costUsd = 0;
    let durationMs = 0;

    const sdkOptions: Record<string, unknown> = {
      model,
      maxTurns: 30,
      permissionMode: 'bypassPermissions',
    };

    // Resume session for follow-up rounds (tool result injection)
    if (claudeSessionId && round > 0) {
      sdkOptions.resume = claudeSessionId;
    } else {
      sdkOptions.customSystemPrompt = systemPrompt;
    }

    const startMs = Date.now();

    const conversation = query({
      prompt: currentPrompt,
      options: sdkOptions as any,
    });

    for await (const message of conversation) {
      if (options.signal?.aborted) break;

      if ('session_id' in message && message.session_id) {
        sessionId = message.session_id as string;
        if (!claudeSessionId) claudeSessionId = sessionId;
      }

      if (message.type === 'assistant') {
        const blocks = message.message.content as Array<{ type: string; text?: string; thinking?: string }>;
        const text = blocks.filter(b => b.type === 'text').map(b => b.text || '').join('');
        if (text) {
          rawResponse = text;
          const display = cleanDisplayText(fullDisplayText + rawResponse);
          options.onText(display);
        }
        // Emit thinking blocks
        if (options.onThinking) {
          const thinking = blocks.filter(b => b.type === 'thinking').map(b => b.thinking || b.text || '').join('');
          if (thinking) {
            options.onThinking(thinking);
          }
        }
      }

      if (message.type === 'result') {
        costUsd = (message as any).total_cost_usd ?? 0;
        durationMs = Date.now() - startMs;
        if ((message as any).subtype === 'success' && (message as any).result) {
          rawResponse = (message as any).result;
        }
        if ((message as any).session_id) {
          claudeSessionId = (message as any).session_id;
        }
      }
    }

    totalCost += costUsd;
    totalDuration += durationMs;

    // Check for tool calls in the response
    if (options.skipTools) {
      fullDisplayText = rawResponse;
      break;
    }

    const { beforeText, toolCall, afterText } = parseToolCalls(rawResponse);

    if (!toolCall) {
      // No tool call — this is the final response
      fullDisplayText += rawResponse;
      fullDisplayText = cleanDisplayText(fullDisplayText);
      options.onText(fullDisplayText);
      break;
    }

    // Found a tool call — execute it
    fullDisplayText += beforeText;
    toolCallCount++;
    const toolId = `tool_${toolCallCount}`;

    options.onToolStart(toolCall.tool, toolCall.args, toolId);

    const toolStartMs = Date.now();
    const result = await executeChatTool(toolCall.tool, toolCall.args, db);
    const toolDuration = Date.now() - toolStartMs;

    options.onToolResult(toolCall.tool, result, toolId, toolDuration);

    // Resume conversation with tool result
    currentPrompt = `<tool_result>
${JSON.stringify(result, null, 2)}
</tool_result>

${afterText ? afterText + '\n\n' : ''}Continue your response using the tool result above. If you need another tool, use <tool_call> again. Otherwise, provide your final answer to the user.`;
  }

  return {
    text: fullDisplayText,
    costUsd: totalCost,
    durationMs: totalDuration,
    model,
    sessionId: claudeSessionId,
  };
}
