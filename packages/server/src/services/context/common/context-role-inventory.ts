import type { Db } from 'mongodb';
import type { WorkflowRoleInventoryEntry } from './context-usage.types.js';

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
    recommendedMandatoryContext: ['implementation workflow guidelines', 'spawn/routing rules', 'planning process rules'],
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
