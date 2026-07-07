import { useCallback, useEffect, useState } from 'react';
import { skills as skillsApi, type SkillRecord } from '../services/api';
import { useToast } from '../components/common/Toast';
import { LibrarySkillsPane } from './RoleManagerPage';

export default function SkillsSettingsPage() {
  const toast = useToast();
  const [skillList, setSkillList] = useState<SkillRecord[]>([]);
  const [loading, setLoading] = useState(true);

  const reloadSkills = useCallback(async () => {
    setLoading(true);
    try {
      const list = await skillsApi.list(true);
      setSkillList((list ?? []).slice().sort((a, b) =>
        (Number(b.priority ?? 0) - Number(a.priority ?? 0))
        || String(a.name ?? '').localeCompare(String(b.name ?? '')),
      ));
    } catch {
      setSkillList([]);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void reloadSkills(); }, [reloadSkills]);

  async function handleSaveSkill(skill: Partial<SkillRecord>) {
    const id = skill._id ?? skill.id;
    if (id) {
      await skillsApi.update(id, skill);
      toast.success(`Skill "${skill.name}" updated.`);
    } else {
      const result: any = await skillsApi.create(skill);
      const isRestored = result?.restored === true;
      toast.success(isRestored
        ? `Skill "${skill.name}" restored.`
        : `Skill "${skill.name}" created.`);
    }
    await reloadSkills();
  }

  async function handleDeleteSkill(skill: SkillRecord) {
    const id = skill._id ?? skill.id;
    if (!id) return;
    await skillsApi.delete(id);
    toast.success(`Skill "${skill.name}" deleted.`);
    await reloadSkills();
  }

  return (
    <LibrarySkillsPane
      variant="settings"
      skills={skillList}
      loading={loading}
      onRefresh={reloadSkills}
      onSave={handleSaveSkill}
      onDelete={handleDeleteSkill}
    />
  );
}
