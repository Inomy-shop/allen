import { useEffect, useState } from 'react';
import { skills as skillsApi, type SkillRecord } from '../services/api';
import type { SlashCommandOption } from '../components/chat/ChatInput';

/** Allen skills load via `/skill <slug>` — one option per enabled skill. */
export function buildSkillSlashCommands(skillList: SkillRecord[] | null | undefined): SlashCommandOption[] {
  return (skillList ?? [])
    .filter(skill => skill.enabled !== false)
    .map(skill => ({
      name: `/skill ${skill.name}`,
      description: skill.description?.trim() || skill.displayName || skill.name,
      provider: 'all',
      source: 'builtin' as const,
      kind: 'allen-skill' as const,
      dispatchable: true,
    }));
}

/** Fetches enabled Allen Library skills once and exposes them as slash options. */
export function useSkillSlashCommands(): SlashCommandOption[] {
  const [options, setOptions] = useState<SlashCommandOption[]>([]);
  useEffect(() => {
    let cancelled = false;
    skillsApi.list(false)
      .then(list => { if (!cancelled) setOptions(buildSkillSlashCommands(list)); })
      .catch(() => { if (!cancelled) setOptions([]); });
    return () => { cancelled = true; };
  }, []);
  return options;
}
