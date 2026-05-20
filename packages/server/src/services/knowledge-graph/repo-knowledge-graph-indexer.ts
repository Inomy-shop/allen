import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Db } from 'mongodb';
import type { KnowledgeCandidateInventory, KnowledgeGraphMode, WorkflowRoleInventoryEntry } from './repo-knowledge-graph.types.js';
import { gitLsFiles, isDocsRunbookCandidatePath, isInstructionCandidatePath, isModuleRuleCandidatePath, isProductionKnowledgeCandidatePath, isSkillCandidatePath, sourceModuleDir } from './repo-knowledge-graph-paths.js';
import { REPO_KNOWLEDGE_GRAPH_MODE_CONTRACT, REPO_KNOWLEDGE_GRAPH_SCHEMA_CONTRACT, REPO_KNOWLEDGE_GRAPH_SHARED_RULES } from './repo-knowledge-graph-indexer-prompts.js';

const WORKFLOW_ROLE_GUIDANCE: Record<string, { category: string; recommendedMandatoryContext: string[]; notes: string }> = {
  'codebase-navigator': {
    category: 'repo-operating',
    recommendedMandatoryContext: ['repo instructions', 'search/navigation guidelines'],
    notes: 'Map mandatory context only for always-load repo navigation guidelines; module maps and source layout are task-specific retrieval context.',
  },
  'bug-investigator': {
    category: 'repo-operating',
    recommendedMandatoryContext: ['investigation guidelines', 'debugging process rules', 'evidence collection guidelines'],
    notes: 'Map mandatory context only for always-load investigation guidelines; failure modes, runbooks, module maps, and logs are task-specific retrieval context.',
  },
  'allen-incident-router': {
    category: 'repo-operating',
    recommendedMandatoryContext: ['incident routing rules', 'escalation guidelines'],
    notes: 'Map mandatory context only for always-load routing guidelines; monitoring runbooks, failure modes, and ownership details are task-specific retrieval context.',
  },
  'allen-monitoring-agent': {
    category: 'repo-operating',
    recommendedMandatoryContext: ['monitoring evidence guidelines', 'diagnostic process rules'],
    notes: 'Map mandatory context only for always-load monitoring guidelines; monitoring docs, runbooks, queries, and production constraints are task-specific retrieval context.',
  },
  'engineering-lead': {
    category: 'repo-operating',
    recommendedMandatoryContext: ['implementation workflow guidelines', 'delegation/routing rules', 'planning process rules'],
    notes: 'Map mandatory context only for always-load engineering workflow guidelines; architecture, module ownership, and validation commands are task-specific retrieval context.',
  },
  'qa-lead': {
    category: 'repo-operating',
    recommendedMandatoryContext: ['testing guidelines', 'validation policy', 'quality gate rules'],
    notes: 'Map mandatory context only for always-load QA guidelines; concrete commands and module-specific test conventions are task-specific retrieval context.',
  },
  'implementation-validator': {
    category: 'repo-operating',
    recommendedMandatoryContext: ['validation policy', 'acceptance criteria guidelines', 'quality gate rules'],
    notes: 'Map mandatory context only for always-load validation guidelines; concrete commands, module tests, and production constraints are task-specific retrieval context.',
  },
  'code-reviewer': {
    category: 'repo-operating',
    recommendedMandatoryContext: ['coding guidelines', 'security review rules', 'testing review guidelines'],
    notes: 'Map mandatory context only for always-load review guidelines; module rules and production constraints should be selected by touched files or task retrieval.',
  },
  'documentation-writer': {
    category: 'repo-operating',
    recommendedMandatoryContext: ['documentation guidelines', 'style/contribution rules'],
    notes: 'Map mandatory context only for always-load documentation guidelines; docs maps, runbooks, and module docs are task-specific retrieval context.',
  },
  'pr-creator': {
    category: 'workflow-support',
    recommendedMandatoryContext: [],
    notes: 'PR creation is an output/support role. Do not map repo mandatory context by default; map only an explicit always-load PR policy written for this role.',
  },
  'pr-review-bot': {
    category: 'repo-operating',
    recommendedMandatoryContext: ['review guidelines', 'security review rules', 'PR conventions'],
    notes: 'Map mandatory context only for always-load PR review guidelines; module ownership and test details are task-specific retrieval context.',
  },
  'pr-workspace-resolver': {
    category: 'workflow-support',
    recommendedMandatoryContext: [],
    notes: 'Workspace resolution is a support role. Do not map repo mandatory context by default; map only an explicit always-load workspace/branch policy written for this role.',
  },
  'prd-creator': {
    category: 'repo-operating',
    recommendedMandatoryContext: ['requirements writing guidelines', 'PRD conventions'],
    notes: 'Map mandatory context only for always-load requirements guidelines; product docs, domain docs, and module maps are task-specific retrieval context.',
  },
  'product-manager': {
    category: 'repo-operating',
    recommendedMandatoryContext: ['product process guidelines', 'requirements conventions'],
    notes: 'Map mandatory context only for always-load product process guidelines; product/domain/roadmap docs are task-specific retrieval context.',
  },
  'requirements-analyst': {
    category: 'repo-operating',
    recommendedMandatoryContext: ['requirements analysis guidelines', 'requirements conventions'],
    notes: 'Map mandatory context only for always-load requirements guidelines; product docs, domain docs, and module maps are task-specific retrieval context.',
  },
  'solution-architect': {
    category: 'repo-operating',
    recommendedMandatoryContext: ['architecture decision guidelines', 'design process rules'],
    notes: 'Map mandatory context only for always-load architecture guidelines; architecture docs, data flows, API contracts, and constraints are task-specific retrieval context.',
  },
  'technical-designer': {
    category: 'repo-operating',
    recommendedMandatoryContext: ['technical design guidelines', 'implementation design process rules'],
    notes: 'Map mandatory context only for always-load technical design guidelines; module rules, API/data contracts, and validation commands are task-specific retrieval context.',
  },
  'backend-developer': {
    category: 'repo-operating',
    recommendedMandatoryContext: ['backend coding guidelines', 'backend safety rules'],
    notes: 'Map mandatory context only for always-load backend coding guidelines, preferably scoped with mandatoryForGlobs; skills, production rules, contracts, and commands are task-specific retrieval context.',
  },
  'frontend-developer': {
    category: 'repo-operating',
    recommendedMandatoryContext: ['frontend coding guidelines', 'UI safety rules'],
    notes: 'Map mandatory context only for always-load frontend coding guidelines, preferably scoped with mandatoryForGlobs; skills, UI docs, and commands are task-specific retrieval context.',
  },
  'security-specialist': {
    category: 'repo-operating',
    recommendedMandatoryContext: ['security review rules', 'secure implementation guidelines'],
    notes: 'Security specialists may investigate, review, or implement security-sensitive changes; map only always-load security guidelines as mandatory.',
  },
  'test-writer': {
    category: 'repo-operating',
    recommendedMandatoryContext: ['testing guidelines', 'validation policy'],
    notes: 'Test-writing roles need repo testing rules; map only always-load testing guidelines as mandatory. Concrete commands and module tests are task-specific retrieval context.',
  },
  'doc-auditor': {
    category: 'workflow-support',
    recommendedMandatoryContext: ['documentation audit guidelines'],
    notes: 'Map mandatory context only when the repo has explicit always-load documentation audit guidelines.',
  },
  'summary-writer': {
    category: 'workflow-support',
    recommendedMandatoryContext: [],
    notes: 'Summary roles aggregate upstream artifacts and should not receive repo mandatory context by default.',
  },
  'workflow-summary': {
    category: 'workflow-support',
    recommendedMandatoryContext: [],
    notes: 'Workflow summary roles aggregate upstream artifacts and should not receive repo mandatory context by default.',
  },
};

export async function buildSpawnedAgentRoleInventory(db: Db): Promise<WorkflowRoleInventoryEntry[]> {
  const docs = await db.collection('agents')
    .find({}, { projection: { name: 1 } })
    .sort({ name: 1 })
    .toArray()
    .catch(() => []);

  return docs
    .map((doc) => typeof doc.name === 'string' ? doc.name.trim() : '')
    .filter((role) => role.length > 0)
    .map((role) => {
      const guidance = workflowRoleGuidance(role);
      return {
        role,
        category: guidance.category,
        workflows: [],
        recommendedMandatoryContext: guidance.recommendedMandatoryContext,
        notes: guidance.notes,
      };
    })
    .sort((a, b) => a.role.localeCompare(b.role));
}

export function buildIndexerUserPrompt(
  repoName: string,
  repoPath: string,
  inventory: KnowledgeCandidateInventory,
  workflowRoleInventory: WorkflowRoleInventoryEntry[],
  spawnedAgentRoleInventory: WorkflowRoleInventoryEntry[] = [],
  graphMode: KnowledgeGraphMode = 'full_graph',
): string {
  const inventoryJson = JSON.stringify(compactInventoryForPrompt(inventory), null, 2);
  const workflowRoleInventoryJson = JSON.stringify(compactWorkflowRoleInventoryForPrompt(workflowRoleInventory), null, 2);
  const spawnedAgentRoleInventoryJson = JSON.stringify(compactWorkflowRoleInventoryForPrompt(spawnedAgentRoleInventory), null, 2);
  const modeRules = graphMode === 'mandatory_context_map'
    ? `Mode-specific rules for mandatory_context_map:
- Build only always-load guideline/policy/process/safety context and role mappings.
- Do not include broad module, source file, production note, runbook, command, command_profile, package script, CI, Docker, or deployment nodes unless the file itself is an always-load guideline or policy.
- Every non-repo path-backed node should either be baseline global guidance or have at least one mandatory role mapping plus a matching MANDATORY_FOR_ROLE edge.`
    : `Mode-specific rules for full_graph:
- Build the complete Allen repo knowledge graph.
- Include broad repo structure, docs/runbooks, production knowledge, command profiles, modules, and source module directories as on-demand graph nodes.
- Mandatory mappings are still narrow: only true always-load guideline/policy/process/safety files should use mandatory role fields.`;
  return `Build a structured repo knowledge graph for "${repoName}" at ${repoPath}.

MODE: ${graphMode}

${REPO_KNOWLEDGE_GRAPH_MODE_CONTRACT}

Allen has already scanned the git-tracked file inventory. Use these exact repo-relative paths. Do not invent paths and do not change path casing:
\`\`\`json
${inventoryJson}
\`\`\`

Allen active workflow node role inventory. These exact role names are the node agents that will consume this graph:
\`\`\`json
${workflowRoleInventoryJson}
\`\`\`

Allen spawned specialist role inventory. These exact role names are child agents that can consume mandatory context in separate spawned sessions:
\`\`\`json
${spawnedAgentRoleInventoryJson}
\`\`\`

Return ONLY a JSON object with this exact shape:
${REPO_KNOWLEDGE_GRAPH_SCHEMA_CONTRACT}

Mandatory role edge representation:
- For every role in mandatoryForNodeRoles, mandatoryForSpawnedAgentRoles, or mandatoryForSpawnerRoles, create an imported_agent role node with id "role-<exact-role-name>", for example "role-bug-investigator".
- Add a MANDATORY_FOR_ROLE edge from each mandatory context node to the matching "role-<exact-role-name>" node.
- The target role node title should identify the role audience, for example "Allen workflow role: <exact-role-name>", "Allen spawned agent role: <exact-role-name>", or "Allen spawner role: <exact-role-name>", and should not have a path.

Index only git-tracked files from the inventory. Never read .env files or secrets.

Shared indexer rules from the DB agent system prompt:
${REPO_KNOWLEDGE_GRAPH_SHARED_RULES}

${modeRules}

Runtime generation rules:
- In full_graph mode, cover global instruction files, repo skills, production knowledge, module rule files, docs/runbooks, source modules, package scripts, CI, and deployment docs from the inventory.
- In mandatory_context_map mode, inspect those inventory categories only to find always-load guidelines/policies/process rules; omit task-specific files from the output graph.
- Use exact paths from the inventory only. If a useful file is absent from the inventory, omit it instead of guessing.
- Keep summaries short selector summaries. They help future agents decide what to load; they must not replace the file body.
- Mark only truly global repo instructions as baseline by leaving them as global instruction nodes. Role-specific and module-specific guidelines should use mandatoryForNodeRoles, mandatoryForSpawnedAgentRoles, mandatoryForSpawnerRoles, appliesToGlobs, mandatoryForGlobs, and MANDATORY_FOR_ROLE/RECOMMENDED_FOR_ROLE edges.
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
      recommendedMandatoryContext: ['always-load coding guidelines', 'implementation process rules'],
      notes: 'Implementation-capable role; map only always-load guideline files as mandatory. Module skills, production knowledge, contracts, and tests are task-specific retrieval context.',
    };
  }
  return {
    category: 'workflow-support',
    recommendedMandatoryContext: ['always-load process guidelines when available'],
    notes: 'Support role; map mandatory repo context only when a candidate file is an always-load guideline for the role.',
  };
}

export function isRepoOperatingWorkflowRole(role: string): boolean {
  return workflowRoleGuidance(role).category === 'repo-operating';
}
