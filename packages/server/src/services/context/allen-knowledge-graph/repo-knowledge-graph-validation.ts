import type { GraphValidationIssue, KnowledgeCandidateInventory, KnowledgeNodeKind, KnowledgeNodeRecord, RawGraphEdge, RawGraphNode, RawKnowledgeGraph, WorkflowRoleInventoryEntry } from './repo-knowledge-graph.types.js';
import { arrayOfStrings, normalizeKind, normalizeRelation, stableNodeKey } from './repo-knowledge-graph-utils.js';
import { sanitizeRepoRelativePath } from './repo-knowledge-graph-paths.js';
import { isRepoOperatingWorkflowRole } from './repo-knowledge-graph-indexer.js';

export interface RepoKnowledgeGraphValidationErrorPayload {
  ok: false;
  code: 'KNOWLEDGE_GRAPH_VALIDATION_FAILED';
  message: string;
  issues: GraphValidationIssue[];
  candidateCoverage: Record<string, unknown>;
  workflowRoleCoverage: Record<string, unknown>;
  repairHints: string[];
}

export class RepoKnowledgeGraphValidationError extends Error {
  readonly payload: RepoKnowledgeGraphValidationErrorPayload;

  constructor(validation: {
    issues: GraphValidationIssue[];
    candidateCoverage: Record<string, unknown>;
    workflowRoleCoverage: Record<string, unknown>;
  }) {
    const errors = validation.issues.filter((issue) => issue.severity === 'error');
    super(`Repo knowledge graph validation failed with ${errors.length} error${errors.length === 1 ? '' : 's'}.`);
    this.name = 'RepoKnowledgeGraphValidationError';
    this.payload = {
      ok: false,
      code: 'KNOWLEDGE_GRAPH_VALIDATION_FAILED',
      message: this.message,
      issues: errors,
      candidateCoverage: validation.candidateCoverage,
      workflowRoleCoverage: validation.workflowRoleCoverage,
      repairHints: buildGraphValidationRepairHints(errors),
    };
  }
}

export function isRepoKnowledgeGraphValidationError(err: unknown): err is RepoKnowledgeGraphValidationError {
  return err instanceof RepoKnowledgeGraphValidationError
    || Boolean((err as { payload?: { code?: string } })?.payload?.code === 'KNOWLEDGE_GRAPH_VALIDATION_FAILED');
}
export function validateRawGraphForPersistence(
  rawNodes: RawGraphNode[],
  rawEdges: RawGraphEdge[],
  inventory: KnowledgeCandidateInventory,
  workflowRoleInventory: WorkflowRoleInventoryEntry[] = [],
  spawnedAgentRoleInventory: WorkflowRoleInventoryEntry[] = [],
  options: { strictWorkflowRoleCoverage?: boolean; mandatoryContextMapMode?: boolean } = {},
): {
  issues: GraphValidationIssue[];
  candidateCoverage: Record<string, unknown>;
  workflowRoleCoverage: Record<string, unknown>;
} {
  const issues: GraphValidationIssue[] = [];
  const trackedSet = new Set(inventory.trackedPaths);
  const lowerTracked = new Map<string, string>();
  for (const path of inventory.trackedPaths) lowerTracked.set(path.toLowerCase(), path);
  const nodeIds = new Set<string>();
  const localIdByRaw = new Map<RawGraphNode, string>();
  const graphPaths = new Set<string>();
  const loadablePathOwners = new Map<string, RawGraphNode[]>();

  for (const raw of rawNodes) {
    const localId = String(raw.id ?? stableNodeKey(raw));
    localIdByRaw.set(raw, localId);
    if (nodeIds.has(localId)) {
      issues.push({ code: 'duplicate_node_id', severity: 'error', nodeId: localId, message: `Duplicate graph node id "${localId}".` });
    }
    nodeIds.add(localId);

    const kind = normalizeKind(raw.kind);
    if (!raw.path) continue;

    let path = '';
    try {
      path = sanitizeRepoRelativePath(String(raw.path));
    } catch (err) {
      issues.push({ code: 'invalid_node_path', severity: 'error', nodeId: localId, path: String(raw.path), message: (err as Error).message });
      continue;
    }
    graphPaths.add(path);
    const exactFile = trackedSet.has(path);
    const dirPrefix = path.replace(/\/+$/, '') + '/';
    const exactDir = inventory.trackedPaths.some((tracked) => tracked.startsWith(dirPrefix));
    if (!exactFile && !exactDir) {
      const expectedPath = lowerTracked.get(path.toLowerCase())
        ?? inventory.trackedPaths.find((tracked) => tracked.toLowerCase().startsWith(dirPrefix.toLowerCase()));
      issues.push({
        code: expectedPath ? 'path_casing_mismatch' : 'node_path_missing',
        severity: 'error',
        nodeId: localId,
        path,
        expectedPath,
        message: expectedPath
          ? `Node path "${path}" does not match git-tracked casing. Use "${expectedPath}".`
          : `Node path "${path}" is not present in the git-tracked repo inventory.`,
      });
      continue;
    }
    if ((isContextBodyLoadableKind(kind) || kind === 'skill' || kind === 'skill_reference') && !exactFile) {
      issues.push({
        code: 'loadable_node_path_not_file',
        severity: 'error',
        nodeId: localId,
        path,
        message: `Loadable ${kind} node path must be an exact git-tracked file, not a directory.`,
      });
    }
    if (isContextBodyLoadableKind(kind) || kind === 'skill' || kind === 'skill_reference') {
      const owners = loadablePathOwners.get(path) ?? [];
      owners.push(raw);
      loadablePathOwners.set(path, owners);
    }
  }

  for (const [path, owners] of loadablePathOwners) {
    if (owners.length <= 1) continue;
    issues.push({
      code: 'duplicate_loadable_path',
      severity: 'warn',
      path,
      count: owners.length,
      message: `Multiple loadable graph nodes point at "${path}". This can confuse usage tracking unless each node has a clearly different meaning.`,
    });
  }

  for (const edge of rawEdges) {
    const from = String(edge.from ?? '');
    const to = String(edge.to ?? '');
    if (!nodeIds.has(from) || !nodeIds.has(to)) {
      issues.push({
        code: 'broken_edge_reference',
        severity: 'error',
        nodeId: !nodeIds.has(from) ? from : to,
        edge: { from, to, relation: String(edge.relation ?? '') },
        expected: 'Both edge endpoints must reference existing graph node ids.',
        actual: { fromExists: nodeIds.has(from), toExists: nodeIds.has(to) },
        message: `Edge ${from || '<missing>'} -> ${to || '<missing>'} references a missing node id.`,
      });
    }
  }

  const instructionNodes = rawNodes.filter((n) => normalizeKind(n.kind) === 'instruction_file');
  const baselineInstructionCount = instructionNodes.filter((n) => {
    try {
      return determineInjectPolicy(n, 'instruction_file', n.path ? sanitizeRepoRelativePath(String(n.path)) : undefined) === 'baseline';
    } catch {
      return false;
    }
  }).length;
  if (instructionNodes.length > 1 && baselineInstructionCount === instructionNodes.length) {
    issues.push({
      code: 'baseline_too_broad',
      severity: 'warn',
      count: baselineInstructionCount,
      message: 'Every instruction_file would be baseline context. Only truly global repo instructions should be baseline.',
    });
  }

  for (const raw of rawNodes) {
    const mandatoryRoles = mandatoryRolesForNode(raw);
    if (mandatoryRoles.length === 0) continue;
    const kind = normalizeKind(raw.kind);
    if (!isUsuallyTaskSpecificKind(kind)) continue;
    const path = raw.path ? safeRepoRelativePath(String(raw.path)) : undefined;
    if (looksLikeAlwaysLoadGuideline(raw, path)) continue;
    const localId = localIdByRaw.get(raw) ?? String(raw.id ?? stableNodeKey(raw));
    issues.push({
      code: 'broad_context_marked_mandatory',
      severity: options.mandatoryContextMapMode ? 'error' : 'warn',
      nodeId: localId,
      path,
      role: mandatoryRoles.join(','),
      actual: {
        kind,
        mandatoryForNodeRoles: arrayOfStrings(raw.mandatoryForNodeRoles),
        mandatoryForSpawnedAgentRoles: arrayOfStrings(raw.mandatoryForSpawnedAgentRoles),
        mandatoryForSpawnerRoles: arrayOfStrings(raw.mandatoryForSpawnerRoles),
      },
      expected: 'Use mandatory role fields only for always-load guideline, policy, process, safety, or role operating instruction files.',
      message: `${kind} node "${localId}" is marked mandatory for ${mandatoryRoles.join(', ')}, but broad repo context is usually task-specific. Keep it on demand unless the file is explicitly an always-load guideline or policy.`,
    });
  }

  const mandatoryRolesFromNodes = new Set<string>();
  const mandatoryWorkflowRolesFromNodes = new Set<string>();
  const mandatorySpawnedRolesFromNodes = new Set<string>();
  const mandatorySpawnerRolesFromNodes = new Set<string>();
  for (const node of rawNodes) {
    for (const role of arrayOfStrings(node.mandatoryForNodeRoles)) {
      mandatoryRolesFromNodes.add(role);
      mandatoryWorkflowRolesFromNodes.add(role);
    }
    for (const role of arrayOfStrings(node.mandatoryForSpawnedAgentRoles)) {
      mandatoryRolesFromNodes.add(role);
      mandatorySpawnedRolesFromNodes.add(role);
    }
    for (const role of arrayOfStrings(node.mandatoryForSpawnerRoles)) {
      mandatoryRolesFromNodes.add(role);
      mandatorySpawnerRolesFromNodes.add(role);
    }
  }
  const workflowRoleNames = new Set(workflowRoleInventory.map((entry) => entry.role));
  const spawnedRoleNames = new Set(spawnedAgentRoleInventory.map((entry) => entry.role));
  const unknownMandatoryRoles = Array.from(mandatoryWorkflowRolesFromNodes)
    .filter((role) => workflowRoleNames.size > 0 && !workflowRoleNames.has(role))
    .sort();
  for (const role of unknownMandatoryRoles) {
    issues.push({
      code: 'unknown_mandatory_workflow_role',
      severity: options.strictWorkflowRoleCoverage ? 'error' : 'warn',
      nodeId: role,
      role,
      expected: Array.from(workflowRoleNames).sort(),
      actual: role,
      message: `mandatoryForNodeRoles contains "${role}", but that is not an active Allen workflow node role. Use exact workflow role names only.`,
    });
  }
  const unknownMandatorySpawnerRoles = Array.from(mandatorySpawnerRolesFromNodes)
    .filter((role) => workflowRoleNames.size > 0 && !workflowRoleNames.has(role))
    .sort();
  for (const role of unknownMandatorySpawnerRoles) {
    issues.push({
      code: 'unknown_mandatory_spawner_role',
      severity: options.strictWorkflowRoleCoverage ? 'error' : 'warn',
      nodeId: role,
      role,
      expected: Array.from(workflowRoleNames).sort(),
      actual: role,
      message: `mandatoryForSpawnerRoles contains "${role}", but that is not an active Allen workflow node role. Use exact workflow role names only.`,
    });
  }
  const unknownMandatorySpawnedRoles = Array.from(mandatorySpawnedRolesFromNodes)
    .filter((role) => !spawnedRoleNames.has(role))
    .sort();
  for (const role of unknownMandatorySpawnedRoles) {
    issues.push({
      code: 'unknown_mandatory_spawned_agent_role',
      severity: 'error',
      nodeId: role,
      role,
      expected: Array.from(spawnedRoleNames).sort(),
      actual: role,
      message: `mandatoryForSpawnedAgentRoles contains "${role}", but that is not an allowed spawned specialist role. Use exact spawned specialist role names only.`,
    });
  }
  const mandatoryRoleNodeCount = rawNodes.filter((n) => mandatoryRolesForNode(n).length > 0).length;
  const mandatoryRoleEdgeCount = rawEdges.filter((e) => normalizeRelation(e.relation) === 'MANDATORY_FOR_ROLE').length;
  if (mandatoryRoleNodeCount > 0 && mandatoryRoleEdgeCount === 0) {
    issues.push({
      code: 'missing_mandatory_role_edges',
      severity: options.strictWorkflowRoleCoverage && workflowRoleNames.size > 0 ? 'error' : 'warn',
      message: 'Graph uses mandatory role fields but does not include MANDATORY_FOR_ROLE edges. Add role edges so graph traversal and diagnostics can explain required context.',
    });
  }

  const repoOperatingRoles = workflowRoleInventory.filter((entry) => isRepoOperatingWorkflowRole(entry.role));
  const missingMandatoryMappingRoles: string[] = [];
  const rawNodeIds = new Set(rawNodes.map((node) => String(node.id ?? stableNodeKey(node))));
  const roleNodeIds = new Map(Array.from(mandatoryRolesFromNodes).map((role) => [role, `role-${role}`]));
  const missingMandatoryRoleEdgeRoles = Array.from(mandatoryRolesFromNodes)
    .filter((role) => workflowRoleNames.size === 0 || workflowRoleNames.has(role))
    .filter((role) => {
      const roleNodeId = roleNodeIds.get(role);
      if (!roleNodeId || !rawNodeIds.has(roleNodeId)) return true;
      return !rawEdges.some((edge) =>
        normalizeRelation(edge.relation) === 'MANDATORY_FOR_ROLE'
        && (String(edge.to ?? '') === roleNodeId || String(edge.from ?? '') === roleNodeId)
      );
    });
  for (const role of missingMandatoryRoleEdgeRoles) {
    issues.push({
      code: 'workflow_role_missing_mandatory_edge',
      severity: options.strictWorkflowRoleCoverage ? 'error' : 'warn',
      nodeId: role,
      role,
      expected: `role-${role} node and at least one MANDATORY_FOR_ROLE edge connected to it.`,
      actual: 'Role node or MANDATORY_FOR_ROLE edge is missing.',
      message: `Active Allen workflow role "${role}" has no role node edge. Add role-${role} and at least one MANDATORY_FOR_ROLE edge to it.`,
    });
  }

  addCoverageWarning(issues, 'missing_instruction_file_coverage', 'instruction files', inventory.instructionFiles, graphPaths);
  addCoverageWarning(issues, 'missing_skill_file_coverage', 'skill files', inventory.skillFiles, graphPaths);
  addCoverageWarning(issues, 'missing_module_rule_coverage', 'module rule files', inventory.moduleRuleFiles, graphPaths);
  addCoverageWarning(issues, 'missing_production_knowledge_coverage', 'production knowledge files', inventory.productionKnowledgeFiles, graphPaths);

  return {
    issues,
    candidateCoverage: {
      instructionFiles: coverageSummary(inventory.instructionFiles, graphPaths),
      skillFiles: coverageSummary(inventory.skillFiles, graphPaths),
      moduleRuleFiles: coverageSummary(inventory.moduleRuleFiles, graphPaths),
      productionKnowledgeFiles: coverageSummary(inventory.productionKnowledgeFiles, graphPaths),
      docsAndRunbooks: coverageSummary(inventory.docsAndRunbooks, graphPaths),
      sourceModuleDirs: coverageSummary(inventory.sourceModuleDirs, graphPaths),
    },
    workflowRoleCoverage: {
      roleCount: workflowRoleInventory.length,
      repoOperatingRoleCount: repoOperatingRoles.length,
      mappedRoles: Array.from(mandatoryRolesFromNodes).sort(),
      mappedWorkflowRoles: Array.from(mandatoryWorkflowRolesFromNodes).sort(),
      mappedSpawnedAgentRoles: Array.from(mandatorySpawnedRolesFromNodes).sort(),
      mappedSpawnerRoles: Array.from(mandatorySpawnerRolesFromNodes).sort(),
      unknownMandatoryRoles,
      unknownMandatorySpawnedRoles,
      unknownMandatorySpawnerRoles,
      missingMandatoryMappingRoles,
      missingMandatoryRoleEdgeRoles,
      mandatoryRoleNodeCount,
      mandatoryRoleEdgeCount,
    },
  };
}

function mandatoryRolesForNode(raw: RawGraphNode): string[] {
  return [
    ...arrayOfStrings(raw.mandatoryForNodeRoles),
    ...arrayOfStrings(raw.mandatoryForSpawnedAgentRoles),
    ...arrayOfStrings(raw.mandatoryForSpawnerRoles),
  ];
}

function isUsuallyTaskSpecificKind(kind: KnowledgeNodeKind): boolean {
  return kind === 'module'
    || kind === 'source_file'
    || kind === 'doc'
    || kind === 'runbook'
    || kind === 'production_note'
    || kind === 'command'
    || kind === 'command_profile';
}

function looksLikeAlwaysLoadGuideline(node: RawGraphNode, path?: string): boolean {
  const tags = arrayOfStrings(node.tags).join(' ');
  const text = `${node.title ?? ''} ${path ?? ''} ${tags}`.toLowerCase();
  return /\b(always[-_\s]?load|guideline|guidelines|policy|policies|rule|rules|standard|standards|convention|conventions|process|procedure|procedures|instruction|instructions|safety|review|testing|validation|coding|style)\b/.test(text);
}

function safeRepoRelativePath(path: string): string | undefined {
  try {
    return sanitizeRepoRelativePath(path);
  } catch {
    return undefined;
  }
}

function addCoverageWarning(
  issues: GraphValidationIssue[],
  code: string,
  label: string,
  expected: string[],
  graphPaths: Set<string>,
): void {
  const missing = expected.filter((path) => !graphPaths.has(path));
  if (expected.length > 0 && missing.length > 0) {
    issues.push({
      code,
      severity: 'warn',
      count: missing.length,
      message: `Graph does not include ${missing.length}/${expected.length} candidate ${label}.`,
    });
  }
}

function buildGraphValidationRepairHints(issues: GraphValidationIssue[]): string[] {
  const codes = new Set(issues.map((issue) => issue.code));
  const hints: string[] = [];
  if (codes.has('node_path_missing') || codes.has('path_casing_mismatch') || codes.has('invalid_node_path')) {
    hints.push('Use only exact repo-relative paths from the git-tracked candidate inventory. Remove untracked files or replace them with tracked candidate paths.');
  }
  if (codes.has('loadable_node_path_not_file')) {
    hints.push('For instruction, context, doc, runbook, production, and skill nodes, point path to an exact git-tracked file, not a directory.');
  }
  if (codes.has('broken_edge_reference')) {
    hints.push('Every edge from/to value must match an existing graph node id after repairs. Remove stale edges or create the missing node ids.');
  }
  if (codes.has('unknown_mandatory_workflow_role')) {
    hints.push('Use only exact Allen workflow role names from the active workflow role inventory in mandatoryForNodeRoles.');
  }
  if (codes.has('unknown_mandatory_spawner_role')) {
    hints.push('Use only exact Allen workflow role names from the active workflow role inventory in mandatoryForSpawnerRoles.');
  }
  if (codes.has('unknown_mandatory_spawned_agent_role')) {
    hints.push('Use only exact spawned specialist role names from the spawned specialist role inventory in mandatoryForSpawnedAgentRoles.');
  }
  if (codes.has('missing_mandatory_role_edges') || codes.has('workflow_role_missing_mandatory_edge')) {
    hints.push('For every mandatory role, create an imported_agent node with id role-<exact-role-name> and add at least one MANDATORY_FOR_ROLE edge connected to it.');
  }
  if (codes.has('duplicate_node_id')) {
    hints.push('Make every graph node id unique and update edges to reference the final ids.');
  }
  if (hints.length === 0) {
    hints.push('Repair the listed validation issues, then call save_repo_knowledge_graph again with the corrected graph.');
  }
  return hints;
}

function coverageSummary(expected: string[], graphPaths: Set<string>): Record<string, unknown> {
  const covered = expected.filter((path) => graphPaths.has(path));
  return {
    expectedCount: expected.length,
    coveredCount: covered.length,
    missingCount: expected.length - covered.length,
    missingSample: expected.filter((path) => !graphPaths.has(path)).slice(0, 20),
  };
}

export function parseGraphJson(text: string): RawKnowledgeGraph {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```json\s*([\s\S]*?)```/i)?.[1];
  const body = fenced ?? trimmed.match(/\{[\s\S]*\}/)?.[0] ?? trimmed;
  const parsed = JSON.parse(body) as RawKnowledgeGraph;
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.nodes)) {
    throw new Error('Knowledge graph agent returned invalid JSON: nodes array is required');
  }
  return parsed;
}

export function determineInjectPolicy(
  raw: RawGraphNode,
  kind: KnowledgeNodeKind,
  path?: string,
): KnowledgeNodeRecord['access']['injectPolicy'] {
  if (kind === 'repo') return 'baseline';
  if (mandatoryRolesForNode(raw).length > 0) return 'on_demand';
  const tags = arrayOfStrings(raw.tags).map((tag) => tag.toLowerCase());
  if (tags.includes('never-auto') || tags.includes('never_auto')) return 'never_auto';
  if ((kind === 'instruction_file' || kind === 'context_file') && path && isGlobalInstructionPath(path)) {
    return 'baseline';
  }
  if (tags.includes('baseline') && !tags.some((tag) => ['backend', 'frontend', 'testing', 'credentials', 'database', 'module'].includes(tag))) {
    return 'baseline';
  }
  return 'on_demand';
}

function isGlobalInstructionPath(path: string): boolean {
  const normalizedPath = path.toLowerCase();
  return [
    'agents.md',
    'agent.md',
    'claude.md',
    '.claude/claude.md',
    '.claude/instructions.md',
    '.codex/instructions.md',
    '.codex/agents.md',
    '.allen.md',
  ].includes(normalizedPath);
}

export function isFileBackedContextKind(kind: string): boolean {
  return ['instruction_file', 'context_file', 'doc', 'runbook', 'production_note'].includes(kind);
}

export function isContextBodyLoadableKind(kind: KnowledgeNodeKind): boolean {
  return isFileBackedContextKind(kind);
}

export function claimRequiresBodyLoad(kind: string): boolean {
  return isFileBackedContextKind(kind) || kind === 'skill' || kind === 'skill_reference';
}
