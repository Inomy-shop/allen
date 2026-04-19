#!/usr/bin/env tsx
/**
 * smoke-claude — end-to-end diagnostic for the Claude Code SDK integration.
 *
 * The engine invokes claude-cli via `@anthropic-ai/claude-code`'s `query()`
 * function. When something goes wrong (cwd missing, PATH broken, stale session,
 * MCP handshake failure, context overflow, invalid tool name) the SDK surfaces
 * a single opaque message: `Claude Code process exited with code 1`. The real
 * cause lives in subprocess stderr, which the SDK pipes to "ignore" unless you
 * pass an `options.stderr` callback.
 *
 * This script reproduces the engine's `callAgent()` spawn path with the
 * stderr callback wired up, plus pre-flight checks for every common source of
 * startup failure. Run it whenever the engine reports a mysterious exit-1 and
 * it will tell you which of the seven known failure modes you've hit.
 *
 * Usage:
 *   tsx packages/engine/scripts/smoke-claude.ts [--cwd DIR] [--model sonnet]
 *                                               [--prompt "text"] [--mcp]
 *                                               [--agent AGENT_NAME]
 *
 * Exit codes:
 *   0 — success (agent completed a turn)
 *   1 — pre-flight failure (PATH, cwd, executable not installed, etc.)
 *   2 — spawn/query failure (the thing we're debugging)
 */

import { existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve as resolvePath } from 'node:path';
import process from 'node:process';

type Args = {
  cwd?: string;
  model: string;
  prompt: string;
  useMcp: boolean;
  agentName?: string;
};

function parseArgs(argv: string[]): Args {
  const out: Args = {
    model: 'sonnet',
    prompt: "Reply with exactly the word PONG and nothing else. Do not call any tools.",
    useMcp: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--cwd') out.cwd = argv[++i];
    else if (a === '--model') out.model = argv[++i];
    else if (a === '--prompt') out.prompt = argv[++i];
    else if (a === '--mcp') out.useMcp = true;
    else if (a === '--agent') out.agentName = argv[++i];
    else if (a === '-h' || a === '--help') {
      console.log(`Usage: tsx scripts/smoke-claude.ts [options]
  --cwd DIR        working directory for claude-cli (default: process.cwd())
  --model NAME     model alias (default: sonnet)
  --prompt TEXT    user prompt (default: trivial PONG ping)
  --mcp            attach the Allen MCP server (tests MCP handshake too)
  --agent NAME     load this agent's system prompt + tools from Mongo
                   (default: plain call with no customSystemPrompt)
`);
      process.exit(0);
    }
  }
  return out;
}

function h1(label: string): void {
  console.log(`\n━━━ ${label} ${'━'.repeat(Math.max(0, 70 - label.length - 5))}`);
}
function ok(msg: string): void { console.log(`  ✓ ${msg}`); }
function warn(msg: string): void { console.log(`  ⚠ ${msg}`); }
function fail(msg: string): void { console.log(`  ✗ ${msg}`); }

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const reqCwd = args.cwd ? resolvePath(args.cwd) : process.cwd();

  h1('1. Environment pre-flight');

  // 1a. node on PATH — the SDK spawns `node claude-cli.mjs`. If node isn't
  // on PATH (common when a task runner strips env), spawn emits the same
  // ENOENT that a missing cwd does, and Node formats both as `spawn node
  // ENOENT`, blaming the executable.
  const whichNode = spawnSync('which', ['node'], { encoding: 'utf8' });
  if (whichNode.status === 0 && whichNode.stdout.trim()) {
    ok(`node resolved on PATH: ${whichNode.stdout.trim()}`);
  } else {
    fail(`node NOT on PATH — child_process.spawn('node', ...) will ENOENT`);
    console.log(`    PATH=${process.env.PATH ?? '(unset)'}`);
    process.exit(1);
  }

  // 1b. cwd must exist. This is the single most common cause of the
  // misleading "spawn node ENOENT" error we just debugged.
  if (!existsSync(reqCwd)) {
    fail(`cwd does not exist: ${reqCwd}`);
    fail(`→ spawn will fail with "spawn node ENOENT" (Node blames the executable, the real issue is the cwd)`);
    process.exit(1);
  }
  if (!statSync(reqCwd).isDirectory()) {
    fail(`cwd is not a directory: ${reqCwd}`);
    process.exit(1);
  }
  ok(`cwd exists and is a directory: ${reqCwd}`);

  // 1c. claude-code package importable
  let query: typeof import('@anthropic-ai/claude-code').query;
  try {
    const sdk = await import('@anthropic-ai/claude-code');
    query = sdk.query;
    ok('@anthropic-ai/claude-code imported');
  } catch (err) {
    fail(`@anthropic-ai/claude-code import failed: ${(err as Error).message}`);
    process.exit(1);
  }

  // 1d. anthropic credentials (either env var or ~/.claude/ config)
  if (process.env.ANTHROPIC_API_KEY) {
    ok('ANTHROPIC_API_KEY present in env');
  } else {
    const homeCreds = `${process.env.HOME}/.claude/credentials.json`;
    if (existsSync(homeCreds)) {
      ok('no ANTHROPIC_API_KEY env, but ~/.claude/credentials.json exists (claude-cli will use it)');
    } else {
      warn('no ANTHROPIC_API_KEY env and no ~/.claude/credentials.json — auth may fail');
    }
  }

  // 2. Optional: load agent config (replicates what executeAgentNode does)
  let customSystemPrompt: string | undefined;
  let allowedTools: string[] = [];
  if (args.agentName) {
    h1(`2. Loading agent "${args.agentName}" from Mongo`);
    try {
      const { MongoClient } = await import('mongodb');
      const url = process.env.MONGODB_URI ?? 'mongodb://localhost:27017';
      const dbName = process.env.MONGODB_DB ?? 'allen';
      const client = new MongoClient(url);
      await client.connect();
      const db = client.db(dbName);
      const role = await db.collection('agents').findOne({ name: args.agentName });
      await client.close();
      if (!role) {
        fail(`agent "${args.agentName}" not found in Mongo ${dbName}.agents`);
        process.exit(1);
      }
      customSystemPrompt = role.system as string | undefined;
      allowedTools = (role.tools as string[]) ?? [];
      ok(`loaded: system=${(customSystemPrompt ?? '').length} chars, tools=${JSON.stringify(allowedTools)}`);
      ok(`model=${role.model}, provider=${role.provider}, planMode=${role.planMode ?? false}`);
    } catch (err) {
      fail(`Mongo load failed: ${(err as Error).message}`);
      process.exit(1);
    }
  }

  // 3. Optional: attach Allen MCP server (tests the stdio handshake)
  let mcpServers: Record<string, unknown> | undefined;
  if (args.useMcp) {
    h1('3. Building Allen MCP server config');
    const mcpScript = resolvePath(process.cwd(), 'packages/server/src/services/allen-mcp-server.ts');
    if (!existsSync(mcpScript)) {
      fail(`MCP server script not found at ${mcpScript} — run from repo root or adjust path`);
      process.exit(1);
    }
    mcpServers = {
      allen: {
        type: 'stdio',
        command: 'npx',
        args: ['tsx', mcpScript],
        env: { ALLEN_API_URL: process.env.ALLEN_API_URL ?? 'http://localhost:4023' },
      },
    };
    ok(`MCP server: npx tsx ${mcpScript}`);
    if (!process.env.JWT_ACCESS_SECRET) {
      warn('JWT_ACCESS_SECRET not in env — MCP server will fail to mint tokens for API calls');
    }
  }

  // 4. The actual query() call — with the stderr callback that the engine
  //    needs to capture the real error. This is the fix we applied to
  //    node-executor.ts earlier — mirrored here so the smoke test has the
  //    same visibility even if the installed engine dist is stale.
  h1('4. Spawning claude-cli via query()');
  const stderrChunks: string[] = [];
  const stderrSeen = (chunk: string) => {
    stderrChunks.push(chunk);
    process.stdout.write(`  [claude-stderr] ${chunk.toString().replace(/\n$/, '')}\n`);
  };

  const startedAt = Date.now();
  console.log(`  prompt: ${JSON.stringify(args.prompt)}`);
  console.log(`  model:  ${args.model}`);
  console.log(`  cwd:    ${reqCwd}`);
  console.log(`  tools:  ${allowedTools.length ? allowedTools.join(',') : '(none)'}`);
  console.log(`  mcp:    ${mcpServers ? Object.keys(mcpServers).join(',') : '(none)'}`);

  let text = '';
  let sessionId: string | undefined;
  let cost: number | null = null;
  let turns = 0;

  try {
    const conv = query({
      prompt: args.prompt,
      options: {
        model: args.model,
        cwd: reqCwd,
        maxTurns: 3,
        permissionMode: 'bypassPermissions',
        customSystemPrompt,
        allowedTools,
        stderr: stderrSeen,
        ...(mcpServers ? { mcpServers: mcpServers as any } : {}),
      } as Record<string, unknown>,
    });

    for await (const message of conv) {
      if (message.type === 'assistant') {
        for (const block of (message as { message: { content: unknown[] } }).message.content) {
          const b = block as { type: string; text?: string; name?: string };
          if (b.type === 'text' && b.text) {
            text += b.text;
            process.stdout.write(`  [agent] ${b.text.replace(/\n/g, '\n          ')}\n`);
          } else if (b.type === 'tool_use' && b.name) {
            process.stdout.write(`  [tool]  ${b.name}\n`);
          }
        }
        turns++;
      } else if (message.type === 'result') {
        const r = message as { session_id?: string; total_cost_usd?: number; num_turns?: number };
        sessionId = r.session_id;
        cost = r.total_cost_usd ?? null;
        turns = r.num_turns ?? turns;
      }
    }
  } catch (err) {
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    h1('✗ FAILED');
    fail(`${(err as Error).message}`);
    console.log(`  elapsed: ${elapsed}s`);
    if (stderrChunks.length > 0) {
      console.log('\n--- captured subprocess stderr (tail) ---');
      console.log(stderrChunks.join('').slice(-4000));
    } else {
      console.log('\n(no stderr captured — either the subprocess crashed before stderr was piped, or the SDK swallowed it.)');
    }
    interpret(err as Error, stderrChunks.join(''));
    process.exit(2);
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  h1('✓ OK');
  ok(`turns=${turns} cost=${cost == null ? '(unknown)' : `$${cost.toFixed(4)}`} elapsed=${elapsed}s`);
  ok(`sessionId=${sessionId ?? '(none)'}`);
  ok(`text=${JSON.stringify(text.slice(0, 200))}`);
  if (stderrChunks.length > 0) {
    console.log('\n(subprocess also emitted stderr — tail below, harmless if run completed)');
    console.log(stderrChunks.join('').slice(-1000));
  }
  process.exit(0);
}

// Pattern-match common failure modes so the operator knows where to look.
function interpret(err: Error, stderr: string): void {
  const msg = err.message;
  const blob = (msg + '\n' + stderr).toLowerCase();
  h1('Likely cause');

  if (/spawn node enoent/.test(blob)) {
    warn('"spawn node ENOENT" is Node\'s AMBIGUOUS error for child_process.spawn.');
    warn('It means EITHER:');
    warn('  (a) `node` is not on PATH — verify with `which node` in the server\'s shell, OR');
    warn('  (b) the `cwd` passed to spawn does not exist / is not readable.');
    warn('Pre-flight already checked PATH above, so if pre-flight passed, it is the cwd.');
  } else if (/enoent/.test(blob)) {
    warn('ENOENT — something the spawn needed is missing. Check cwd, PATH, and the claude-cli path.');
  } else if (/overloaded|rate.?limit|429/.test(blob)) {
    warn('Rate limit / overloaded. Retry with backoff or switch models.');
  } else if (/input.*too.*(long|large)|max.*tokens|context.*(length|window)|400/.test(blob)) {
    warn('Prompt / context overflow. The combined customSystemPrompt + user prompt + tools exceed the model\'s cap.');
    warn('Try: --agent with a smaller agent, or a shorter --prompt, or drop --mcp.');
  } else if (/unauthorized|401|credential|api key/.test(blob)) {
    warn('Authentication failed. Check ANTHROPIC_API_KEY or ~/.claude/credentials.json.');
  } else if (/mcp|handshake|jsonrpc/.test(blob)) {
    warn('MCP handshake failure. The Allen MCP server failed to initialize. Check JWT_ACCESS_SECRET, ALLEN_API_URL, and that `npx tsx` works from the server\'s PATH.');
  } else if (/exited with code 1/.test(blob) && !stderr) {
    warn('Opaque exit-1 with no stderr captured. The subprocess crashed before the SDK wired up stderr piping.');
    warn('Try: DEBUG=1 tsx scripts/smoke-claude.ts … to force the SDK into debug mode.');
  } else {
    warn('No recognized pattern — inspect the stderr tail above manually.');
  }
}

main().catch(err => {
  console.error('\nsmoke-claude crashed:', err);
  process.exit(3);
});
