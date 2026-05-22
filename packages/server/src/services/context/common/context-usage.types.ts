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

export interface WorkflowRoleInventoryEntry {
  role: string;
  category: string;
  workflows: Array<{ workflowName: string; nodeName: string }>;
  recommendedMandatoryContext: string[];
  notes: string;
}
