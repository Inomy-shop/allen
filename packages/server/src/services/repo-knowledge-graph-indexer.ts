import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Db } from 'mongodb';
import type { KnowledgeCandidateInventory, WorkflowRoleInventoryEntry } from './repo-knowledge-graph.types.js';
import { gitLsFiles, isDocsRunbookCandidatePath, isInstructionCandidatePath, isModuleRuleCandidatePath, isProductionKnowledgeCandidatePath, isSkillCandidatePath, sourceModuleDir } from './repo-knowledge-graph-paths.js';

const WORKFLOW_ROLE_GUIDANCE: Record<string, { category: string; recommendedMandatoryContext: string[]; notes: string }> = {
  'bug-investigator': {
    category: 'repo-operating',
    recommendedMandatoryContext: ['production rules', 'failure modes', 'runbooks', 'module map', 'log/debugging commands', 'validation commands'],
    notes: 'Must understand how the repo fails in production and how to reproduce or localize the issue.',
  },
  'engineering-lead': {
    category: 'repo-operating',
    recommendedMandatoryContext: ['architecture docs', 'module ownership', 'implementation planning rules', 'specialist routing rules', 'validation commands'],
    notes: 'Must route work to the right implementation roles with repo-specific constraints.',
  },
  'qa-lead': {
    category: 'repo-operating',
    recommendedMandatoryContext: ['test strategy', 'validation commands', 'module test conventions', 'production risk checks'],
    notes: 'Must verify implementation using repo-specific test and validation rules.',
  },
  'implementation-validator': {
    category: 'repo-operating',
    recommendedMandatoryContext: ['validation commands', 'acceptance criteria conventions', 'module test conventions', 'production constraints'],
    notes: 'Must validate implementation against repo-specific quality gates.',
  },
  'code-reviewer': {
    category: 'repo-operating',
    recommendedMandatoryContext: ['coding guidelines', 'security rules', 'module rules', 'test expectations', 'production constraints'],
    notes: 'Must review changes against repo-specific engineering rules.',
  },
  'documentation-writer': {
    category: 'repo-operating',
    recommendedMandatoryContext: ['documentation conventions', 'docs map', 'runbooks', 'module documentation'],
    notes: 'Must update docs consistently with repo-specific documentation structure.',
  },
  'pr-creator': {
    category: 'repo-operating',
    recommendedMandatoryContext: ['PR conventions', 'branch/base rules', 'commit conventions', 'validation summary requirements'],
    notes: 'Must prepare repo-specific PR metadata and validation notes.',
  },
  'requirements-analyst': {
    category: 'repo-operating',
    recommendedMandatoryContext: ['product docs', 'domain docs', 'module map', 'existing requirements conventions'],
    notes: 'Must ground requirements in existing repo/domain documentation when available.',
  },
  'solution-architect': {
    category: 'repo-operating',
    recommendedMandatoryContext: ['architecture docs', 'data flow docs', 'API contracts', 'module boundaries', 'production constraints'],
    notes: 'Must design within repo architecture and production constraints.',
  },
  'technical-designer': {
    category: 'repo-operating',
    recommendedMandatoryContext: ['architecture docs', 'module rules', 'API contracts', 'data contracts', 'validation commands'],
    notes: 'Must produce repo-specific implementation design.',
  },
  'backend-developer': {
    category: 'repo-operating',
    recommendedMandatoryContext: ['backend coding rules', 'backend skills', 'production rules', 'API/data contracts', 'backend validation commands'],
    notes: 'Must implement backend changes using module-specific repo guidance.',
  },
  'frontend-developer': {
    category: 'repo-operating',
    recommendedMandatoryContext: ['frontend coding rules', 'frontend skills', 'UI conventions', 'frontend validation commands'],
    notes: 'Must implement frontend changes using module-specific repo guidance.',
  },
  'doc-auditor': {
    category: 'workflow-support',
    recommendedMandatoryContext: ['documentation conventions', 'docs map'],
    notes: 'Map mandatory context only when the repo has explicit documentation audit rules.',
  },
};
export function buildIndexerPrompt(
  repoName: string,
  repoPath: string,
  inventory: KnowledgeCandidateInventory,
  workflowRoleInventory: WorkflowRoleInventoryEntry[],
): string {
  const inventoryJson = JSON.stringify(compactInventoryForPrompt(inventory), null, 2);
  const workflowRoleInventoryJson = JSON.stringify(compactWorkflowRoleInventoryForPrompt(workflowRoleInventory), null, 2);
  return `Build a structured repo knowledge graph for "${repoName}" at ${repoPath}.

Allen has already scanned the git-tracked file inventory. Use these exact repo-relative paths. Do not invent paths and do not change path casing:
\`\`\`json
${inventoryJson}
\`\`\`

Allen active workflow node role inventory. These exact role names are the node agents that will consume this graph:
\`\`\`json
${workflowRoleInventoryJson}
\`\`\`

Return ONLY a JSON object with this exact shape:
{
  "repoSummary": "short summary",
  "nodes": [
    {
      "id": "stable-local-id",
      "kind": "module | source_file | context_file | doc | runbook | skill | skill_reference | production_note | instruction_file | command | command_profile | imported_agent | historical_learning",
      "title": "human title",
      "path": "repo-relative path when applicable",
      "summary": "what future workflow agents need to know",
      "tags": ["short", "tags"],
      "moduleId": "module id if applicable",
      "appliesToGlobs": ["path/**"],
      "mandatoryForGlobs": ["path/**"],
      "mandatoryForNodeRoles": ["backend-developer"]
    }
  ],
  "edges": [
    {
      "from": "node id",
      "to": "node id",
      "relation": "CONTAINS | APPLIES_TO | REQUIRES | REFERENCES | IMPLEMENTS | VALIDATED_BY | RECOMMENDED_FOR_ROLE | MANDATORY_FOR_ROLE | SUPERSEDES | DERIVED_FROM",
      "confidence": 0.0,
      "reason": "brief reason"
    }
  ]
}

Mandatory role edge representation:
- For every role in mandatoryForNodeRoles, create an imported_agent role node with id "role-<exact-role-name>", for example "role-bug-investigator".
- Add a MANDATORY_FOR_ROLE edge from each mandatory context node to the matching "role-<exact-role-name>" node.
- The target role node title should be "Allen workflow role: <exact-role-name>" and should not have a path.

Index only git-tracked files from the inventory. Never read .env files or secrets.

Generation rules:
- First cover global instruction files, repo skills, production knowledge, module rule files, docs/runbooks, source modules, package scripts, CI, and deployment docs from the inventory.
- Use exact paths from the inventory only. If a useful file is absent from the inventory, omit it instead of guessing.
- Keep summaries short selector summaries. They help future agents decide what to load; they must not replace the file body.
- CRITICAL: mandatoryForNodeRoles must contain ONLY exact Allen workflow role names from the role inventory. Do not put repo-native agent names there unless the exact same name appears in the active Allen workflow role inventory.
- Repo-native files under .claude/agents, .codex, or .agents are knowledge sources and may become imported_agent nodes, but they are not Allen workflow role names unless the same name appears in the role inventory.
- For each repo-operating workflow role in the role inventory, map at least one mandatory context file. If no role-specific file exists, use the most relevant global repo instruction, architecture, production, or validation file rather than leaving the role unmapped.
- Typical mandatory mappings: bug-investigator needs failure modes, production rules, module map, logs/runbooks, and validation commands; engineering-lead needs architecture, module ownership, implementation planning, and specialist routing rules; qa-lead and implementation-validator need test strategy and validation commands; code-reviewer needs coding/security/testing guidelines and relevant module rules; documentation-writer needs docs conventions and docs/runbook map; pr-creator needs PR, branch, and contribution rules; solution-architect and technical-designer need architecture, data flow, API contracts, and module boundaries; backend/frontend developer roles need their module coding rules, skills, production rules, and validation commands.
- Command profile files such as package.json, CI workflow YAML, Dockerfiles, docker-compose files, build scripts, and deploy configs are useful graph nodes, but they are not globally mandatory context. Mark command profiles mandatory only for roles/tasks that truly need command execution, validation, package scripts, CI, Docker, deployment, runtime packaging, or dependency behavior, such as qa-lead, implementation-validator, pr-creator, or release/deploy-focused roles.
- Do not mark command profiles mandatory for broad investigation, engineering-lead, design, documentation, or review roles unless the specific file is directly required by that role's normal work in this repo. Prefer rule/guideline, production knowledge, runbook, architecture, and module context files as mandatory context for those roles.
- Mark only truly global repo instructions as baseline by leaving them as global instruction nodes. Role-specific and module-specific rules should use mandatoryForNodeRoles, appliesToGlobs, mandatoryForGlobs, and MANDATORY_FOR_ROLE/RECOMMENDED_FOR_ROLE edges.
- Add MANDATORY_FOR_ROLE edges for context that a role must load before work. The node should also include that role in mandatoryForNodeRoles.
- Before returning JSON, internally verify that every repo-operating role has at least one node containing that exact role in mandatoryForNodeRoles and at least one MANDATORY_FOR_ROLE edge to role-<exact-role-name>.
- Use confidence 1.0 only for relationships directly stated by files or package scripts. Use confidence below 0.7 for inferred relationships.
- Avoid duplicate nodes pointing at the same file unless the concepts are clearly separate and the summaries explain the difference.`;
}

function compactWorkflowRoleInventoryForPrompt(workflowRoleInventory: WorkflowRoleInventoryEntry[]): Record<string, unknown> {
  return {
    roles: workflowRoleInventory.map((entry) => ({
      role: entry.role,
      category: entry.category,
      workflows: entry.workflows,
      recommendedMandatoryContext: entry.recommendedMandatoryContext,
      notes: entry.notes,
    })),
  };
}

function compactInventoryForPrompt(inventory: KnowledgeCandidateInventory): Record<string, unknown> {
  return {
    instructionFiles: inventory.instructionFiles,
    skillFiles: inventory.skillFiles,
    productionKnowledgeFiles: inventory.productionKnowledgeFiles,
    moduleRuleFiles: inventory.moduleRuleFiles,
    docsAndRunbooks: inventory.docsAndRunbooks,
    sourceModuleDirs: inventory.sourceModuleDirs,
    packageScripts: inventory.packageScripts,
  };
}

export async function buildKnowledgeCandidateInventory(repoPath: string): Promise<KnowledgeCandidateInventory> {
  const trackedPaths = await gitLsFiles(repoPath);
  const instructionFiles = trackedPaths.filter(isInstructionCandidatePath);
  const skillFiles = trackedPaths.filter(isSkillCandidatePath);
  const productionKnowledgeFiles = trackedPaths.filter(isProductionKnowledgeCandidatePath);
  const moduleRuleFiles = trackedPaths.filter(isModuleRuleCandidatePath);
  const docsAndRunbooks = trackedPaths.filter(isDocsRunbookCandidatePath);
  const sourceModuleDirs = Array.from(new Set(trackedPaths
    .map(sourceModuleDir)
    .filter((v): v is string => Boolean(v))))
    .sort();
  const packageScripts: Array<{ path: string; scripts: Record<string, string> }> = [];
  for (const path of trackedPaths.filter((p) => p === 'package.json' || /(^|\/)package\.json$/.test(p))) {
    try {
      const parsed = JSON.parse(await readFile(join(repoPath, path), 'utf8')) as { scripts?: Record<string, string> };
      if (parsed.scripts && Object.keys(parsed.scripts).length > 0) packageScripts.push({ path, scripts: parsed.scripts });
    } catch {
      // Ignore malformed package.json files during inventory; graph validation
      // still operates on the path list.
    }
  }
  return {
    trackedPaths,
    instructionFiles,
    skillFiles,
    productionKnowledgeFiles,
    moduleRuleFiles,
    docsAndRunbooks,
    sourceModuleDirs,
    packageScripts,
  };
}

export async function buildWorkflowRoleInventory(db: Db): Promise<WorkflowRoleInventoryEntry[]> {
  const docs = await db.collection('workflows')
    .find({ archived: { $ne: true } }, { projection: { name: 1, parsed: 1, nodes: 1 } })
    .toArray()
    .catch(() => []);
  const byRole = new Map<string, { role: string; workflows: Array<{ workflowName: string; nodeName: string }> }>();

  for (const doc of docs) {
    const workflowName = String((doc.parsed as { name?: unknown } | undefined)?.name ?? doc.name ?? '');
    if (!workflowName) continue;
    const nodes = ((doc.parsed as { nodes?: unknown } | undefined)?.nodes ?? doc.nodes) as unknown;
    if (!nodes || typeof nodes !== 'object' || Array.isArray(nodes)) continue;

    for (const [nodeName, nodeDef] of Object.entries(nodes as Record<string, unknown>)) {
      if (!nodeDef || typeof nodeDef !== 'object') continue;
      const agent = (nodeDef as { agent?: unknown }).agent;
      if (typeof agent !== 'string' || !agent.trim()) continue;
      const role = agent.trim();
      const entry = byRole.get(role) ?? { role, workflows: [] };
      entry.workflows.push({ workflowName, nodeName });
      byRole.set(role, entry);
    }
  }

  return Array.from(byRole.values())
    .sort((a, b) => a.role.localeCompare(b.role))
    .map((entry) => {
      const guidance = workflowRoleGuidance(entry.role);
      return {
        role: entry.role,
        category: guidance.category,
        workflows: entry.workflows.sort((a, b) => `${a.workflowName}:${a.nodeName}`.localeCompare(`${b.workflowName}:${b.nodeName}`)),
        recommendedMandatoryContext: guidance.recommendedMandatoryContext,
        notes: guidance.notes,
      };
    });
}

export function workflowRoleGuidance(role: string): { category: string; recommendedMandatoryContext: string[]; notes: string } {
  const normalized = role.toLowerCase();
  const guidance = WORKFLOW_ROLE_GUIDANCE[normalized];
  if (guidance) return guidance;
  if (normalized.includes('developer') || normalized.includes('engineer')) {
    return {
      category: 'repo-operating',
      recommendedMandatoryContext: ['module coding rules', 'repo instructions', 'skills for touched module', 'production constraints', 'validation commands'],
      notes: 'Implementation-capable role; map relevant repo rules, module skills, production knowledge, and tests.',
    };
  }
  return {
    category: 'workflow-support',
    recommendedMandatoryContext: ['repo instructions when directly relevant', 'docs or process rules when available'],
    notes: 'Support role; map mandatory repo context only when a candidate file clearly applies to the role.',
  };
}

export function isRepoOperatingWorkflowRole(role: string): boolean {
  return workflowRoleGuidance(role).category === 'repo-operating';
}
