import type { ObjectId } from 'mongodb';

export const KNOWLEDGE_GRAPH_INDEX_VERSION = 1;

export type KnowledgeGraphMode = 'full_graph' | 'mandatory_context_map';

export type KnowledgeNodeKind =
  | 'repo'
  | 'module'
  | 'source_file'
  | 'context_file'
  | 'doc'
  | 'runbook'
  | 'skill'
  | 'skill_reference'
  | 'production_note'
  | 'instruction_file'
  | 'command'
  | 'command_profile'
  | 'imported_agent'
  | 'historical_learning';

export type KnowledgeRelation =
  | 'CONTAINS'
  | 'APPLIES_TO'
  | 'REQUIRES'
  | 'REFERENCES'
  | 'IMPLEMENTS'
  | 'VALIDATED_BY'
  | 'RECOMMENDED_FOR_ROLE'
  | 'MANDATORY_FOR_ROLE'
  | 'SUPERSEDES'
  | 'DERIVED_FROM';

export interface RawGraphNode {
  id?: string;
  kind?: KnowledgeNodeKind;
  title?: string;
  path?: string;
  summary?: string;
  tags?: string[];
  moduleId?: string;
  appliesToGlobs?: string[];
  mandatoryForGlobs?: string[];
  mandatoryForNodeRoles?: string[];
  mandatoryForSpawnedAgentRoles?: string[];
  mandatoryForSpawnerRoles?: string[];
}

export interface RawGraphEdge {
  from?: string;
  to?: string;
  relation?: KnowledgeRelation;
  confidence?: number;
  reason?: string;
}

export interface RawKnowledgeGraph {
  repoSummary?: string;
  nodes?: RawGraphNode[];
  edges?: RawGraphEdge[];
}

export interface KnowledgeCandidateInventory {
  trackedPaths: string[];
  instructionFiles: string[];
  skillFiles: string[];
  productionKnowledgeFiles: string[];
  moduleRuleFiles: string[];
  docsAndRunbooks: string[];
  sourceModuleDirs: string[];
  packageScripts: Array<{ path: string; scripts: Record<string, string> }>;
}

export interface WorkflowRoleInventoryEntry {
  role: string;
  category: string;
  workflows: Array<{ workflowName: string; nodeName: string }>;
  recommendedMandatoryContext: string[];
  notes: string;
}

export interface GraphValidationIssue {
  code: string;
  severity: 'error' | 'warn';
  message: string;
  nodeId?: string;
  path?: string;
  expectedPath?: string;
  role?: string;
  expected?: unknown;
  actual?: unknown;
  edge?: { from?: string; to?: string; relation?: string };
  count?: number;
}

export interface UsageToolCall {
  tool?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  toolUseId?: string;
}

export interface ParsedUsage {
  moduleIdentified?: string;
  summaryUsed: Array<Record<string, unknown>>;
  preselected: Array<Record<string, unknown>>;
  reportedLoaded: Array<Record<string, unknown>>;
  reportedApplied: Array<Record<string, unknown>>;
  loaded: Array<Record<string, unknown>>;
  applied: Array<Record<string, unknown>>;
  skipped: Array<Record<string, unknown>>;
  validationPerformed: Array<Record<string, unknown>>;
  usageSummary?: string;
  extractionSources: string[];
  skillBodyLoads: Array<Record<string, unknown>>;
  contextBodyLoads: Array<Record<string, unknown>>;
  unverifiedClaims: Array<Record<string, unknown>>;
  malformedReportedUsage: Array<Record<string, unknown>>;
  diagnostics: Array<Record<string, unknown>>;
  sawUsageKeys: boolean;
}

export interface KnowledgeNodeRecord {
  _id?: ObjectId;
  id: string;
  stableKey: string;
  repoId: string;
  indexId: string;
  headSha?: string;
  kind: KnowledgeNodeKind;
  title: string;
  path?: string;
  summary: string;
  tags: string[];
  moduleId?: string;
  appliesToGlobs?: string[];
  mandatoryForGlobs?: string[];
  mandatoryForNodeRoles?: string[];
  mandatoryForSpawnedAgentRoles?: string[];
  mandatoryForSpawnerRoles?: string[];
  source: {
    type: 'repo_file' | 'allen_db' | 'imported_agent' | 'generated_summary';
    uri: string;
  };
  freshness: {
    lastSeenAt: Date;
    contentHash: string;
    stale: boolean;
  };
  access: {
    visibility: 'repo' | 'org_private' | 'operator_private';
    injectPolicy: 'baseline' | 'on_demand' | 'never_auto';
  };
  createdAt: Date;
  updatedAt: Date;
}

export interface KnowledgeEdgeRecord {
  id: string;
  repoId: string;
  indexId: string;
  fromNodeId: string;
  toNodeId: string;
  relation: KnowledgeRelation;
  confidence: number;
  reason: string;
  createdBy: 'daily_indexer' | 'operator' | 'importer' | 'workflow_trace';
  createdAt: Date;
}
