/**
 * Org Context — builds a live, description-rich org chart block for
 * injection into agent system prompts at runtime.
 *
 * Why this exists:
 *   Hand-writing each lead's spawn targets into `org-seed.ts` means every
 *   org change (add/rename/remove an agent) requires editing every mention of
 *   that agent across every lead prompt. Instead, we keep `spawnTargets` as
 *   structured routing data in the DB and render the human-readable description block
 *   from the current agents/teams rows at prompt-build time.
 *
 * Used by:
 *   - chat.service.ts buildAgentSystemPrompt (when a lead/agent is selected)
 *   - chat.service.ts getSystemPrompt (Allen Assistant default)
 *   - engine/node-executor.ts (workflow-mode agent calls)
 */

import type { Db } from 'mongodb';
import { notDeletedFilter } from './soft-delete.js';

export interface OrgContextOptions {
  /** Render a per-agent "suggested spawn targets" section for this agent. */
  forAgent?: string;
  /** Render the full org chart (all teams + members). Default: true. */
  includeFullChart?: boolean;
  /** Full member list or compact team/lead summary. Default: full. */
  chartMode?: 'full' | 'summary';
  /** Include the meta team in the chart. Default: true. */
  includeMeta?: boolean;
}

/**
 * Build a flat, description-rich org chart block for runtime prompt injection.
 * Returns an empty string if both includeFullChart is false and there are no
 * spawn targets to render.
 */
export async function buildOrgContextBlock(
  db: Db,
  options: OrgContextOptions = {},
): Promise<string> {
  try {
    const [teams, agents] = await Promise.all([
      db.collection('teams').find(notDeletedFilter).toArray(),
      db.collection('agents').find(notDeletedFilter).toArray(),
    ]);

    const agentByName = new Map<string, any>(agents.map((a: any) => [a.name, a]));
    const includeMeta = options.includeMeta !== false;
    const includeChart = options.includeFullChart !== false;
    const chartMode = options.chartMode ?? 'full';
    const visibleTeams = teams.filter((t: any) => includeMeta || t.name !== 'meta');

    const lines: string[] = [];

    // ── Flat org chart ──
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
        if (chartMode === 'summary') {
          const summaryDesc = team.description ? ` — ${String(team.description).replace(/[.;\s]+$/, '')}` : '';
          const leads = members.filter((m: any) => m.teamRole === 'lead').map((m: any) => m.name).join(', ') || 'none';
          lines.push(`- ${teamLabel} team${summaryDesc}; lead(s): ${leads}; members: ${members.length}`);
          continue;
        }

        lines.push(`**${teamLabel} team**${teamDesc}`);
        for (const m of members) {
          const role = m.teamRole === 'lead' ? ' (lead)' : '';
          const desc = (m.description as string) ?? (m.displayName as string) ?? m.name;
          lines.push(`- ${m.name}${role} — ${desc}`);
        }
        lines.push('');
      }
    }

    // ── Per-agent spawn targets ──
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
          if (!ag || ag.isDeleted) continue;
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
