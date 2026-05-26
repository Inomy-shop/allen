export function isAgentAdjacentContextPath(rawPath: string): boolean {
  const path = rawPath.toLowerCase();
  return path.startsWith('.claude/agents/')
    || path.startsWith('.agents/')
    || path.includes('/.claude/agents/')
    || path.includes('/.agents/')
    || /(^|\/)(agent-memory|agent-memories|agent-learnings|learnings)(\/|$)/.test(path);
}

export function isAgentMemoryOrLearningPath(rawPath: string): boolean {
  const path = rawPath.toLowerCase();
  const basename = path.split('/').pop() ?? path;
  return /(^|\/)(memory|memories|learnings)(\/|$)/.test(path)
    || /(learning|learnings|memory|memories|lesson|lessons)/.test(basename);
}

export function hasAgentSystemInstructionSignals(text: string): boolean {
  return scorePatterns(text, [
    /\byou are\b/i,
    /\bsystem prompt\b/i,
    /\bagent persona\b/i,
    /\bsub-?agent\b/i,
    /\ballowed tools\b/i,
    /\bmcp__\w+/i,
    /\bspawn_agent\b/i,
    /\bdelegate\b|\bdelegation\b/i,
    /\bfinal response\b/i,
    /\bguardrails?\b/i,
    /\brole instructions?\b/i,
    /\bteam role\b/i,
    /\bworkflow node role\b/i,
    /\bdo not (edit|write|commit|push|run)\b/i,
    /\bmust (call|use|spawn|delegate|respond)\b/i,
  ]) >= 2;
}

export function hasProductionLearningSignals(text: string): boolean {
  const strongSignals = scorePatterns(text, [
    /\blearnings?\b/i,
    /\blessons?\b/i,
    /\bgotchas?\b/i,
    /\bincident\b|\bpostmortem\b/i,
    /\broot cause\b/i,
    /\bfailure mode\b/i,
    /\bknown issue\b/i,
    /\bworkaround\b/i,
    /\bdebugging?\b/i,
    /\bproduction\b/i,
    /\bsource[- ]of[- ]truth\b/i,
  ]);
  const technicalSignals = scorePatterns(text, [
    /\bschema\b|\btable\b|\bcolumn\b/i,
    /\bmigration\b/i,
    /\bendpoint\b|\bapi\b/i,
    /\bservice\b|\bmodule\b|\bpipeline\b/i,
    /\bquery\b|\bindex\b/i,
    /\bconfig\b|\bcontract\b/i,
    /\bacceptance criteri(a|on)\b/i,
    /\btest\b|\bspec\b/i,
    /\bdata flow\b/i,
    /\bvariant\b|\bgrouping\b|\bproduct\b/i,
  ]);
  return strongSignals >= 2 || (strongSignals >= 1 && technicalSignals >= 1) || technicalSignals >= 4;
}

export function shouldBlockAgentAdjacentInjection(input: {
  path: string;
  category: string;
  inclusion: string;
  injectionPolicy: string;
  text: string;
}): { code: string; message: string } | null {
  const category = input.category.toLowerCase();
  const inclusion = input.inclusion.toLowerCase();
  const policy = input.injectionPolicy.toLowerCase();
  const isInclude = inclusion === 'include' || inclusion === 'condensed';
  if (category === 'agent_persona' && isInclude && policy === 'snippet') {
    return {
      code: 'agent_persona_not_injectable',
      message: 'Agent persona/system prompt material cannot be staged as injectable snippet context.',
    };
  }

  const isAgentAdjacent = isAgentAdjacentContextPath(input.path) || category === 'agent_persona';
  if (!isAgentAdjacent || !isInclude) return null;
  if (hasAgentSystemInstructionSignals(input.text) && !hasProductionLearningSignals(input.text)) {
    return {
      code: 'agent_adjacent_entry_requires_review',
      message: 'Agent-adjacent file appears to contain persona/system instructions without reusable production learnings.',
    };
  }
  return null;
}

export function agentAdjacentDiagnosticReason(code: string): string {
  if (code === 'agent_persona_not_injectable') {
    return 'agent_persona_not_injectable: persona/system prompt context is not injectable production context.';
  }
  return 'agent_adjacent_entry_requires_review: agent-adjacent material was excluded because it looked like persona/system instructions, not source-grounded production learning.';
}

function scorePatterns(text: string, patterns: RegExp[]): number {
  if (!text.trim()) return 0;
  return patterns.reduce((score, pattern) => score + (pattern.test(text) ? 1 : 0), 0);
}
