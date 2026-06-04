/**
 * Org Context (engine-side) — builds the same live org chart block used by
 * chat.service.ts, so workflow-mode agent calls see identical context.
 *
 * Duplicated intentionally: the engine package cannot depend on the server
 * package. Both copies must stay in sync — the rendered output is what
 * matters for prompt consistency.
 */

import type { Db } from 'mongodb';

export interface OrgContextOptions {
  forAgent?: string;
  includeFullChart?: boolean;
  includeMeta?: boolean;
}

export async function buildOrgContextBlock(
  db: Db,
  options: OrgContextOptions = {},
): Promise<string> {
  try {
    const [teams, agents] = await Promise.all([
      db.collection('teams').find({}).toArray(),
      db.collection('agents').find({}).toArray(),
    ]);

    const agentByName = new Map<string, any>(agents.map((a: any) => [a.name, a]));
    const includeMeta = options.includeMeta !== false;
    const includeChart = options.includeFullChart !== false;
    const visibleTeams = teams.filter((t: any) => includeMeta || t.name !== 'meta');

    const lines: string[] = [];

    if (includeChart) {
      lines.push('## Organisation');
      lines.push('');
      for (const team of visibleTeams) {
        const members = agents
          .filter((a: any) => a.teamName === team.name)
          .sort((a: any, b: any) => {
            if (a.teamRole === 'lead' && b.teamRole !== 'lead') return -1;
            if (b.teamRole === 'lead' && a.teamRole !== 'lead') return 1;
            return (a.name as string).localeCompare(b.name as string);
          });
        if (members.length === 0) continue;

        const teamLabel = team.displayName ?? team.name;
        const teamDesc = team.description ? ` — ${team.description}` : '';
        lines.push(`**${teamLabel} team**${teamDesc}`);

        for (const m of members) {
          const role = m.teamRole === 'lead' ? ' (lead)' : '';
          const desc = (m.description as string) ?? (m.displayName as string) ?? m.name;
          lines.push(`- ${m.name}${role} — ${desc}`);
        }
        lines.push('');
      }
    }

    if (options.forAgent) {
      const self = agentByName.get(options.forAgent);
      const targets = ((self?.spawnTargets as string[] | undefined) ?? []).filter(Boolean);
      if (targets.length > 0) {
        lines.push('## Suggested spawn targets');
        lines.push('');
        lines.push('Call `spawn_agent(agent_name, prompt)` with one of:');
        lines.push('');
        for (const t of targets) {
          const ag = agentByName.get(t);
          if (!ag) continue;
          const team = ag.teamName ? ` [${ag.teamName}]` : '';
          const desc = (ag.description as string) ?? (ag.displayName as string) ?? ag.name;
          lines.push(`- ${ag.name}${team} — ${desc}`);
        }
        lines.push('');
        lines.push('Pick the most specific target. Do NOT do the work yourself if a specialist exists.');
      }
    }

    return lines.join('\n').trim();
  } catch (err) {
    console.error('[org-context] Failed to build org context block:', (err as Error).message);
    return '';
  }
}
