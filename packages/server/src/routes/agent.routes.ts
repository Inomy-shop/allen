import { Router, type Request, type Response } from 'express';
import { param } from '../types.js';
import { ObjectId, type Db } from 'mongodb';
import { resolveAgentSettings, AgentSettingsValidationError, type AgentLike } from '../services/agent-settings.js';
import { notDeletedFilter, softDeleteSet, restoreSet } from '../services/soft-delete.js';
import {
  scanRepoForClaudeAgents,
  resolveImportActions,
  type ParsedClaudeAgent,
} from '../services/claude-agents-importer.js';
import { executeChatTool } from '../services/chat-tools.js';
import { getAgentDefaults } from '../services/llm-defaults.js';
import { PROVIDERS, getOpenRouterNonClaudeWarning, type ChatProvider } from '../services/chat-providers.js';

const ALLOWED_EFFORTS = new Set(['off', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const PROVIDER_IDS = new Set(PROVIDERS.map((provider) => provider.provider));
const BULK_MODEL_CLEARABLE_CODES = new Set(['plan_mode_claude_only']);

type BulkModelSkipped = {
  name: string;
  reason: 'not-found' | 'incompatible-settings';
  code?: string;
  message?: string;
};

type BulkModelRequest = {
  agentNames: string[];
  provider: ChatProvider;
  model: string;
  clearIncompatibleSettings: boolean;
};

type AgentBundle = {
  version?: number;
  kind?: string;
  exportedAt?: string;
  agents?: Record<string, unknown>[];
  teams?: Record<string, unknown>[];
};

function sanitizePortableAgent(agent: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...agent };
  delete copy._id;
  delete copy.createdAt;
  delete copy.updatedAt;
  delete copy.sourceRepoId;
  delete copy.sourceRepoPath;
  delete copy.sourceFile;
  delete copy.sourceSha;
  copy.isBuiltIn = false;
  copy.createdBy = 'import';
  return copy;
}

function sanitizePortableTeam(team: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...team };
  delete copy._id;
  delete copy.createdAt;
  delete copy.updatedAt;
  copy.isBuiltIn = false;
  copy.createdBy = 'import';
  return copy;
}

function parseAgentNames(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : [];
  return [...new Set(raw.map((name) => typeof name === 'string' ? name.trim() : '').filter(Boolean))];
}


function titleFromAgentSlug(slug: string): string {
  return slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function validateAgentSettingsFields(body: Record<string, unknown>): void {
  if (body.reasoningEffort !== undefined && body.reasoningEffort !== null) {
    if (typeof body.reasoningEffort !== 'string' || !ALLOWED_EFFORTS.has(body.reasoningEffort)) {
      throw new AgentSettingsValidationError(
        'invalid_reasoning_effort',
        `reasoningEffort must be one of ${[...ALLOWED_EFFORTS].join(', ')}`,
      );
    }
  }
  if (body.planMode !== undefined && body.planMode !== null && typeof body.planMode !== 'boolean') {
    throw new AgentSettingsValidationError('invalid_plan_mode', 'planMode must be a boolean');
  }
  // Semantic validation (currently planMode+provider) runs via resolve on the merged agent.
  const probe: AgentLike = {
    name: (body.name as string) ?? 'probe',
    provider: body.provider as string | undefined,
    model: body.model as string | undefined,
    reasoningEffort: body.reasoningEffort as AgentLike['reasoningEffort'],
    planMode: body.planMode as boolean | undefined,
  };
  resolveAgentSettings(probe);
}

function validateBulkModelRequest(body: unknown): BulkModelRequest {
  const input = (body ?? {}) as Record<string, unknown>;
  if (!Array.isArray(input.agentNames) || input.agentNames.length === 0) {
    throw Object.assign(
      new Error('agentNames must be a non-empty array of unique non-empty strings'),
      { code: 'invalid_agent_names' },
    );
  }

  const agentNames: string[] = [];
  const seen = new Set<string>();
  for (const raw of input.agentNames) {
    if (typeof raw !== 'string' || !raw.trim()) {
      throw Object.assign(
        new Error('agentNames must be a non-empty array of unique non-empty strings'),
        { code: 'invalid_agent_names' },
      );
    }
    const name = raw.trim();
    if (seen.has(name)) {
      throw Object.assign(new Error('agentNames must be unique'), { code: 'duplicate_agent_names' });
    }
    seen.add(name);
    agentNames.push(name);
  }

  // Legacy provider id: 'claude-cli' is accepted on input forever, stored as 'claude'.
  if (input.provider === 'claude-cli') input.provider = 'claude';
  if (typeof input.provider !== 'string' || !PROVIDER_IDS.has(input.provider as ChatProvider)) {
    throw Object.assign(
      new Error(`provider must be one of: ${[...PROVIDER_IDS].join(', ')}`),
      { code: 'invalid_provider' },
    );
  }

  if (typeof input.model !== 'string' || !input.model.trim()) {
    throw Object.assign(new Error('model must be a non-empty string'), { code: 'invalid_model' });
  }

  if (input.clearIncompatibleSettings !== undefined && typeof input.clearIncompatibleSettings !== 'boolean') {
    throw Object.assign(
      new Error('clearIncompatibleSettings must be a boolean'),
      { code: 'invalid_clear_incompatible_settings' },
    );
  }

  return {
    agentNames,
    provider: input.provider as ChatProvider,
    model: input.model.trim(),
    clearIncompatibleSettings: input.clearIncompatibleSettings === true,
  };
}

function validateBulkModelCandidate(
  existing: Record<string, unknown>,
  provider: ChatProvider,
  model: string,
  unsetFields: Set<'planMode' | 'reasoningEffort'>,
): void {
  const candidate: Record<string, unknown> = { ...existing, provider, model };
  for (const field of unsetFields) {
    delete candidate[field];
  }
  validateAgentSettingsFields(candidate);
}

function markClearableBulkModelField(
  err: AgentSettingsValidationError,
  existing: Record<string, unknown>,
  unsetFields: Set<'planMode' | 'reasoningEffort'>,
): boolean {
  if (!BULK_MODEL_CLEARABLE_CODES.has(err.code)) return false;

  if (err.code === 'plan_mode_claude_only' && !unsetFields.has('planMode')) {
    unsetFields.add('planMode');
    return true;
  }

  return false;
}

export function agentRoutes(db: Db): Router {
  const router = Router();
  const col = db.collection('agents');

  // POST /api/agents/export — portable JSON bundle for selected/all agents.
  router.post('/export', async (req: Request, res: Response) => {
    try {
      const agentNames = parseAgentNames(req.body?.agentNames);
      const filter = agentNames.length > 0
        ? { name: { $in: agentNames }, ...notDeletedFilter }
        : notDeletedFilter;
      const rows = await col.find(filter).sort({ name: 1 }).toArray();
      const exportedAgents = rows.map((agent) => sanitizePortableAgent(agent as Record<string, unknown>));
      const teamNames = [...new Set(exportedAgents
        .map((agent) => typeof agent.teamName === 'string' ? agent.teamName : '')
        .filter(Boolean))];
      const teams = teamNames.length > 0
        ? await db.collection('teams').find({ name: { $in: teamNames }, ...notDeletedFilter }).sort({ name: 1 }).toArray()
        : [];

      res.json({
        kind: 'allen-agents-bundle',
        version: 1,
        exportedAt: new Date().toISOString(),
        agents: exportedAgents,
        teams: teams.map((team) => sanitizePortableTeam(team as Record<string, unknown>)),
      });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/agents/import/json — import agents exported by /agents/export.
  router.post('/import/json', async (req: Request, res: Response) => {
    try {
      const bundle = (req.body ?? {}) as AgentBundle;
      const incomingAgents = Array.isArray(bundle.agents) ? bundle.agents : [];
      const incomingTeams = Array.isArray(bundle.teams) ? bundle.teams : [];
      if (incomingAgents.length === 0) {
        return res.status(400).json({ error: 'agents must be a non-empty array' });
      }

      const createdTeams: string[] = [];
      const skippedTeams: { name: string; reason: string }[] = [];
      for (const rawTeam of incomingTeams) {
        const name = typeof rawTeam.name === 'string' ? rawTeam.name.trim() : '';
        const displayName = typeof rawTeam.displayName === 'string' ? rawTeam.displayName.trim() : '';
        const leadAgentName = typeof rawTeam.leadAgentName === 'string' ? rawTeam.leadAgentName.trim() : '';
        if (!name || !displayName || !leadAgentName) {
          skippedTeams.push({ name: name || '(missing)', reason: 'invalid-team' });
          continue;
        }
        const existing = await db.collection('teams').findOne({ name });
        if (existing) {
          skippedTeams.push({ name, reason: 'already-exists' });
          continue;
        }
        const teamDoc = {
          ...sanitizePortableTeam(rawTeam),
          name,
          displayName,
          leadAgentName,
          description: typeof rawTeam.description === 'string' ? rawTeam.description : '',
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        await db.collection('teams').insertOne(teamDoc);
        createdTeams.push(name);
      }

      const created: string[] = [];
      const skipped: { name: string; reason: string }[] = [];
      for (const rawAgent of incomingAgents) {
        const name = typeof rawAgent.name === 'string' ? rawAgent.name.trim() : '';
        if (!name) {
          skipped.push({ name: '(missing)', reason: 'invalid-agent' });
          continue;
        }
        const existing = await col.findOne({ name });
        if (existing) {
          if (existing.isDeleted) {
            // Restore soft-deleted record with the imported data
            await col.updateOne({ name }, restoreSet(sanitizePortableAgent(rawAgent)));
            created.push(name + ' (restored)');
            continue;
          }
          skipped.push({ name, reason: 'already-exists' });
          continue;
        }

        const agentDoc = {
          ...sanitizePortableAgent(rawAgent),
          name,
          displayName: typeof rawAgent.displayName === 'string' && rawAgent.displayName.trim()
            ? rawAgent.displayName.trim()
            : titleFromAgentSlug(name),
          teamName: typeof rawAgent.teamName === 'string' && rawAgent.teamName.trim() ? rawAgent.teamName.trim() : 'unassigned',
          teamRole: rawAgent.teamRole === 'lead' ? 'lead' : 'member',
          provider: typeof rawAgent.provider === 'string' ? rawAgent.provider : getAgentDefaults().provider,
          model: typeof rawAgent.model === 'string' ? rawAgent.model : getAgentDefaults().model,
          isBuiltIn: false,
          createdBy: 'import',
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        validateAgentSettingsFields(agentDoc);
        await col.insertOne(agentDoc);
        created.push(name);
      }

      res.status(201).json({ created, skipped, createdTeams, skippedTeams });
    } catch (err: unknown) {
      if (err instanceof AgentSettingsValidationError) {
        return res.status(400).json({ error: err.message, code: err.code });
      }
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/agents
  router.get('/', async (_req: Request, res: Response) => {
    try {
      const agents = await col.find(notDeletedFilter).sort({ name: 1 }).toArray();
      res.json(agents);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/agents
  router.post('/', async (req: Request, res: Response) => {
    try {
      // Strip protected fields — these can ONLY be set by the seed migration or
      // by team-builder/agent-builder via the meta chat tools. Allowing them on
      // a public POST would let any client bypass the meta-team permission gating.
      const body = { ...req.body };
      const agentName = (body.name ?? '') as string;
      delete body._id;
      delete body.teamName;
      delete body.teamRole;
      delete body.isBuiltIn;
      delete body.createdBy;
      delete body.createdAt;
      // Source-of-record fields — only the import endpoints may set these.
      delete body.sourceRepoId;
      delete body.sourceRepoPath;
      delete body.sourceFile;
      delete body.sourceSha;

      validateAgentSettingsFields(body);

      // Check for soft-deleted record with the same name — restore instead of insert
      if (agentName) {
        const deleted = await col.findOne({ name: agentName, isDeleted: true });
        if (deleted) {
          const agentPayload = {
            ...body,
            isBuiltIn: false,
            createdBy: 'user',
          };
          await col.updateOne({ name: agentName }, restoreSet(agentPayload));
          const restored = await col.findOne({ name: agentName });
          return res.status(200).json({ restored: true, _id: restored?._id, name: agentName });
        }
      }

      const agent = {
        ...body,
        isBuiltIn: false,
        createdBy: 'user',
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const result = await col.insertOne(agent);
      const warning = getOpenRouterNonClaudeWarning(body.provider, body.model);
      const response: Record<string, unknown> = { ...agent, _id: result.insertedId };
      if (warning) response.warning = warning;
      res.status(201).json(response);
    } catch (err: unknown) {
      if (err instanceof AgentSettingsValidationError) {
        return res.status(400).json({ error: err.message, code: err.code });
      }
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // PUT /api/agents/:name
  router.put('/:name', async (req: Request, res: Response) => {
    try {
      const { name } = req.params;
      // Strip protected fields — see POST handler comment. The meta team is
      // the only authority on team membership, lead promotion, and built-in flags.
      const updates = { ...req.body, updatedAt: new Date() };
      delete updates._id;
      delete updates.name;
      delete updates.teamName;
      delete updates.teamRole;
      delete updates.isBuiltIn;
      delete updates.createdBy;
      delete updates.createdAt;
      delete updates.sourceRepoId;
      delete updates.sourceRepoPath;
      delete updates.sourceFile;
      delete updates.sourceSha;

      // For PUT, fold the update over the existing doc before validating — that
      // way someone toggling just `planMode` doesn't have to resend `provider`.
      const existing = await col.findOne({ name, ...notDeletedFilter });
      if (!existing) return res.status(404).json({ error: 'Agent not found' });
      validateAgentSettingsFields({ ...existing, ...updates });

      const result = await col.updateOne({ name }, { $set: updates });
      if (result.matchedCount === 0) return res.status(404).json({ error: 'Agent not found' });
      const merged = { ...existing, ...updates };
      const warning = getOpenRouterNonClaudeWarning(merged.provider, merged.model);
      const response: Record<string, unknown> = { name, ...updates };
      if (warning) response.warning = warning;
      res.json(response);
    } catch (err: unknown) {
      if (err instanceof AgentSettingsValidationError) {
        return res.status(400).json({ error: err.message, code: err.code });
      }
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // DELETE /api/agents/:name
  router.delete('/:name', async (req: Request, res: Response) => {
    try {
      const agentName = param(req, 'name');
      const agent = await col.findOne({ name: agentName });
      if (!agent) return res.status(404).json({ error: 'Agent not found' });

      // Built-in agents cannot be deleted
      if (agent.isBuiltIn) {
        return res.status(403).json({ error: `Agent "${agentName}" is built-in and cannot be deleted` });
      }

      // Team leads with an active team cannot be deleted
      if (agent.teamRole === 'lead' && agent.teamName) {
        const team = await db.collection('teams').findOne({ name: agent.teamName, ...notDeletedFilter });
        if (team && !team.isBuiltIn) {
          return res.status(409).json({
            error: `Cannot delete "${agentName}" — they are the lead of team "${agent.teamName}". Either assign a new lead first (via update_agent on a different member), or delete the team via delete_team.`,
          });
        }
      }

      await col.updateOne({ name: agentName }, softDeleteSet(req.body?.userId?.toString() ?? null));
      res.status(204).send();
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/agents/:name/run — One-shot agent run from the Agents page.
  // Delegates to the existing spawn_agent chat tool so behaviour is identical
  // to how an orchestrator agent spawns a specialist: same execution row shape,
  // same runSpawnInBackground path, same wait_for_execution polling contract. The
  // UI can then navigate to /executions/:execution_id for the live view.
  router.post('/:name/run', async (req: Request, res: Response) => {
    try {
      const agentName = param(req, 'name');
      // Reject run requests for deleted agents
      const agentRow = await col.findOne({ name: agentName, ...notDeletedFilter });
      if (!agentRow) {
        return res.status(404).json({ error: `Agent "${agentName}" not found or has been deleted` });
      }
      const prompt = req.body?.prompt as string | undefined;
      const contextQuery = req.body?.context_query;
      const repoPath = req.body?.repo_path as string | undefined;
      const sessionId = req.body?.session_id as string | undefined;
      if (!prompt || !prompt.trim()) {
        return res.status(400).json({ error: 'prompt is required' });
      }
      const result = await executeChatTool(
        'spawn_agent',
        { agent_name: agentName, prompt, context_query: contextQuery, repo_path: repoPath, session_id: sessionId },
        db,
      );
      if (result.error) return res.status(400).json(result);
      res.status(202).json(result);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Import Claude agents from a registered repo ─────────────────────────
  //
  // Two-step flow: preview tells the UI what would happen, commit actually
  // inserts the rows. Both endpoints run the same resolver server-side so
  // the client can't forge verdicts.

  async function loadRepo(repoId: string): Promise<Record<string, unknown> | null> {
    let oid: ObjectId;
    try { oid = new ObjectId(repoId); }
    catch { return null; }
    return db.collection('repos').findOne({ _id: oid });
  }

  // POST /api/agents/import/preview  { repoId }
  router.post('/import/preview', async (req: Request, res: Response) => {
    try {
      const repoId = req.body?.repoId as string | undefined;
      if (!repoId) return res.status(400).json({ error: 'repoId is required' });
      const repo = await loadRepo(repoId);
      if (!repo) return res.status(404).json({ error: 'Repo not found' });

      const scan = scanRepoForClaudeAgents(repo.path as string);
      const verdicts = await resolveImportActions(db, repo._id as ObjectId, scan);
      res.json({
        repo: { _id: String(repo._id), name: repo.name, path: repo.path },
        verdicts,
      });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/agents/import  { repoId, agentNames: string[] }
  router.post('/import', async (req: Request, res: Response) => {
    try {
      const repoId = req.body?.repoId as string | undefined;
      const agentNames = (req.body?.agentNames ?? []) as string[];
      if (!repoId) return res.status(400).json({ error: 'repoId is required' });
      if (!Array.isArray(agentNames) || agentNames.length === 0) {
        return res.status(400).json({ error: 'agentNames must be a non-empty array' });
      }
      const repo = await loadRepo(repoId);
      if (!repo) return res.status(404).json({ error: 'Repo not found' });

      const scan = scanRepoForClaudeAgents(repo.path as string);
      const verdicts = await resolveImportActions(db, repo._id as ObjectId, scan);

      const created: string[] = [];
      const skipped: { name: string; reason: string }[] = [];

      for (const v of verdicts) {
        if (v.kind !== 'create') {
          // Surface skipped items only if the caller asked for them.
          const file = v.kind === 'skip:parse-error' ? v.file : v.agent.name;
          if (agentNames.includes(file)) {
            skipped.push({ name: file, reason: v.kind });
          }
          continue;
        }
        if (!agentNames.includes(v.agent.name)) continue;

        // Re-check name at commit time — protects against races between
        // preview and commit where another caller imported the same slug.
        const conflict = await col.findOne({ name: v.agent.name });
        if (conflict) {
          if (conflict.isDeleted) {
            // Restore soft-deleted record with the imported data
            await col.updateOne({ name: v.agent.name }, restoreSet(buildImportedAgentDoc(v.agent, repo)));
            created.push(v.agent.name + ' (restored)');
            continue;
          }
          skipped.push({ name: v.agent.name, reason: 'skip:name-collision' });
          continue;
        }

        const doc = buildImportedAgentDoc(v.agent, repo);
        try {
          await col.insertOne(doc);
          created.push(v.agent.name);
        } catch (err) {
          skipped.push({ name: v.agent.name, reason: `insert-failed: ${(err as Error).message}` });
        }
      }

      res.status(201).json({ created, skipped });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/agents/:name/resync — re-read the source file and update the
  // existing agent row. Bypasses the "already-imported" refusal because the
  // user explicitly asked for it.
  router.post('/:name/resync', async (req: Request, res: Response) => {
    try {
      const name = param(req, 'name');
      const agent = await col.findOne({ name });
      if (!agent) return res.status(404).json({ error: 'Agent not found' });
      if (!agent.sourceRepoId || !agent.sourceFile) {
        return res.status(400).json({ error: `Agent "${name}" was not imported — nothing to resync` });
      }
      const repo = await db.collection('repos').findOne({ _id: agent.sourceRepoId as ObjectId });
      if (!repo) return res.status(404).json({ error: 'Source repo no longer registered' });

      const scan = scanRepoForClaudeAgents(repo.path as string);
      const match = scan.parsed.find(p => p.sourceFile === agent.sourceFile);
      if (!match) {
        const err = scan.errors.find(e => e.file === agent.sourceFile);
        return res.status(404).json({
          error: err ? `Source file parse error: ${err.error}` : 'Source file no longer exists in repo',
        });
      }

      await col.updateOne(
        { name },
        {
          $set: {
            description: match.description,
            tools: match.tools,
            model: match.model,
            system: match.system,
            sourceSha: match.sourceSha,
            sourceRepoPath: repo.path as string,
            updatedAt: new Date(),
          },
        },
      );
      res.json({ success: true, name, sha: match.sourceSha });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // PATCH /api/agents/:name/team  { teamName, teamRole }
  router.patch('/:name/team', async (req: Request, res: Response) => {
    try {
      const name = param(req, 'name');
      const teamName = req.body?.teamName as string | undefined;
      const teamRole = (req.body?.teamRole ?? 'member') as 'lead' | 'member';
      if (!teamName) return res.status(400).json({ error: 'teamName is required' });
      if (teamRole !== 'lead' && teamRole !== 'member') {
        return res.status(400).json({ error: 'teamRole must be "lead" or "member"' });
      }

      const agent = await col.findOne({ name, ...notDeletedFilter });
      if (!agent) return res.status(404).json({ error: 'Agent not found' });

      // Verify the target team exists (unless it's the unassigned holding area,
      // which is seeded but we tolerate the absence defensively).
      const targetTeam = await db.collection('teams').findOne({ name: teamName, ...notDeletedFilter });
      if (!targetTeam && teamName !== 'unassigned') {
        return res.status(404).json({ error: `Team "${teamName}" does not exist` });
      }

      // Lead uniqueness check — partial index will reject the update anyway,
      // but a clean 409 beats a raw Mongo error.
      if (teamRole === 'lead') {
        const existingLead = await col.findOne({ teamName, teamRole: 'lead' });
        if (existingLead && existingLead.name !== name) {
          return res.status(409).json({
            error: `Team "${teamName}" already has lead "${existingLead.name}". Demote the existing lead first.`,
          });
        }
      }

      await col.updateOne(
        { name },
        { $set: { teamName, teamRole, updatedAt: new Date() } },
      );
      res.json({ success: true, name, teamName, teamRole });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/agents/bulk-team  { agentNames, teamName, autoWireSpawnTargets? }
  // Move many agents into an existing team at once. All moves are members.
  // Optionally append the moved agent names to the team lead's spawnTargets
  // so the new members are reachable as spawn targets. Default on.
  router.post('/bulk-team', async (req: Request, res: Response) => {
    try {
      const agentNames = (req.body?.agentNames ?? []) as string[];
      const teamName = req.body?.teamName as string | undefined;
      const autoWire = req.body?.autoWireSpawnTargets ?? true;
      if (!teamName) return res.status(400).json({ error: 'teamName is required' });
      if (!Array.isArray(agentNames) || agentNames.length === 0) {
        return res.status(400).json({ error: 'agentNames must be a non-empty array' });
      }

      const team = await db.collection('teams').findOne({ name: teamName, ...notDeletedFilter });
      if (!team && teamName !== 'unassigned') {
        return res.status(404).json({ error: `Team "${teamName}" does not exist` });
      }

      const moved: string[] = [];
      const skipped: { name: string; reason: string }[] = [];

      for (const n of agentNames) {
        const agent = await col.findOne({ name: n });
        if (!agent) {
          skipped.push({ name: n, reason: 'not-found' });
          continue;
        }
        await col.updateOne(
          { name: n },
          { $set: { teamName, teamRole: 'member', updatedAt: new Date() } },
        );
        moved.push(n);
      }

      // Auto-wire spawn targets: append moved members to the team lead's
      // spawnTargets list so the new arrivals are reachable immediately.
      if (autoWire && team?.leadAgentName && moved.length > 0) {
        const leadName = team.leadAgentName as string;
        const lead = await col.findOne({ name: leadName });
        if (lead) {
          const existing = (lead.spawnTargets as string[] | undefined) ?? [];
          const merged = Array.from(new Set([...existing, ...moved]));
          if (merged.length !== existing.length) {
            await col.updateOne(
              { name: leadName },
              { $set: { spawnTargets: merged, updatedAt: new Date() } },
            );
          }
        }
      }

      res.json({ moved, skipped, autoWireSpawnTargets: autoWire });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/agents/bulk-model  { agentNames, provider, model, clearIncompatibleSettings? }
  // Update provider/model for selected agents. Missing or semantically incompatible
  // agents are skipped so compatible selected agents can still be updated.
  router.post('/bulk-model', async (req: Request, res: Response) => {
    try {
      const { agentNames, provider, model, clearIncompatibleSettings } = validateBulkModelRequest(req.body);
      const updated: string[] = [];
      const skipped: BulkModelSkipped[] = [];

      for (const name of agentNames) {
        const existing = await col.findOne({ name, ...notDeletedFilter });
        if (!existing) {
          skipped.push({ name, reason: 'not-found' });
          continue;
        }

        const unsetFields = new Set<'planMode' | 'reasoningEffort'>();
        let validationError: AgentSettingsValidationError | null = null;

        for (let attempt = 0; attempt <= 2; attempt += 1) {
          try {
            validateBulkModelCandidate(existing, provider, model, unsetFields);
            validationError = null;
            break;
          } catch (err) {
            if (!(err instanceof AgentSettingsValidationError)) throw err;
            validationError = err;
            if (!clearIncompatibleSettings || !markClearableBulkModelField(err, existing, unsetFields)) {
              break;
            }
          }
        }

        if (validationError) {
          skipped.push({
            name,
            reason: 'incompatible-settings',
            code: validationError.code,
            message: validationError.message,
          });
          continue;
        }

        const update: {
          $set: { provider: ChatProvider; model: string; updatedAt: Date };
          $unset?: Partial<Record<'planMode' | 'reasoningEffort', ''>>;
        } = {
          $set: { provider, model, updatedAt: new Date() },
        };
        if (unsetFields.size > 0) {
          update.$unset = {};
          for (const field of unsetFields) {
            update.$unset[field] = '';
          }
        }

        const result = await col.updateOne({ name }, update);
        if (result.matchedCount === 0) {
          skipped.push({ name, reason: 'not-found' });
          continue;
        }
        updated.push(name);
      }

      const warning = getOpenRouterNonClaudeWarning(provider, model);
      res.json({ updated, skipped, ...(warning ? { warning } : {}) });
    } catch (err: unknown) {
      if (err instanceof AgentSettingsValidationError) {
        return res.status(400).json({ error: err.message, code: err.code });
      }
      const codedError = err as Error & { code?: string };
      if (codedError.code) {
        return res.status(400).json({ error: codedError.message, code: codedError.code });
      }
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}

/**
 * Build the MongoDB document for a newly imported Claude agent.
 * Non-negotiable fields are set here; everything else derives from the
 * parsed frontmatter + body. Imported agents always start in the
 * `unassigned` team so the UI's team-grouping shows them clearly and
 * `org-context.ts` can render them without special-casing orphans.
 */
function buildImportedAgentDoc(
  parsed: ParsedClaudeAgent,
  repo: Record<string, unknown>,
): Record<string, unknown> {
  const defaults = getAgentDefaults();
  return {
    name: parsed.name,
    displayName: titleFromAgentSlug(parsed.name),
    description: parsed.description,
    teamName: 'unassigned',
    teamRole: 'member',
    type: 'technical',
    provider: defaults.provider,
    model: parsed.model ?? defaults.model,
    tools: parsed.tools,
    capabilities: [],
    spawnTargets: [],
    canTrigger: [],
    personality: '',
    icon: 'bot',
    color: '#6366f1',
    system: parsed.system,
    isBuiltIn: false,
    createdBy: 'import',
    sourceRepoId: repo._id,
    sourceRepoPath: repo.path,
    sourceFile: parsed.sourceFile,
    sourceSha: parsed.sourceSha,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}
