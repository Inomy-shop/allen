import type { ParsedUsage, UsageToolCall } from './repo-knowledge-graph.types.js';
import { claimRequiresBodyLoad } from './repo-knowledge-graph-validation.js';
import { firstString, isRecord } from './repo-knowledge-graph-utils.js';

export function extractUsage(outputs: Record<string, unknown>, rawResponse?: string, toolCalls?: UsageToolCall[]): ParsedUsage {
  const candidates: Array<{ source: string; value: Record<string, unknown> }> = [];
  collectUsageCandidates(outputs, 'outputs', candidates);
  for (const candidate of parseJsonCandidates(rawResponse)) {
    collectUsageCandidates(candidate.value, candidate.source, candidates);
  }

  const explicit = candidates.filter((candidate) => candidate.source.endsWith('.repo_context_usage') || candidate.source.includes('.repo_context_usage.'));
  const ordered = explicit.length > 0 ? explicit : candidates;
  const merged = ordered.reduce((acc, candidate) => mergeUsage(acc, usageFromRecord(candidate.value)), emptyUsage());
  const reportedLoaded = merged.loaded;
  const reportedApplied = merged.applied;
  const skillBodyLoads = extractSkillBodyLoads(toolCalls);
  const contextBodyLoads = extractContextBodyLoads(toolCalls);
  merged.skillBodyLoads = skillBodyLoads;
  merged.contextBodyLoads = contextBodyLoads;
  merged.reportedLoaded = reportedLoaded;
  merged.reportedApplied = reportedApplied;
  merged.loaded = mergeUsageArrays([], [...skillBodyLoads, ...contextBodyLoads]);
  const verifiedBodyRefIds = new Set(merged.loaded.map((item) => firstString(item.refId, item.ref_id)).filter((v): v is string => Boolean(v)));
  merged.applied = reportedApplied.filter((item) => {
    const refId = firstString(item.refId, item.ref_id);
    return Boolean(refId && verifiedBodyRefIds.has(refId));
  });
  merged.extractionSources = Array.from(new Set(ordered.map((candidate) => candidate.source)));
  merged.sawUsageKeys = candidates.length > 0 || hasUsageKeyText(rawResponse);
  return merged;
}

function usageFromRecord(usage: Record<string, unknown>): ParsedUsage {
  const preselected = normalizeReportedContextUsageArray(usage.context_preselected ?? usage.contextPreselected, 'context_preselected');
  const summaryUsed = normalizeReportedContextUsageArray(usage.context_summary_used ?? usage.contextSummaryUsed ?? usage.summaryUsed, 'context_summary_used');
  const loaded = normalizeReportedContextUsageArray(usage.context_loaded ?? usage.loaded, 'context_loaded');
  const applied = normalizeReportedContextUsageArray(usage.context_applied ?? usage.contextApplied ?? usage.claimedUsed, 'context_applied');
  const skipped = normalizeReportedContextUsageArray(usage.context_skipped ?? usage.skipped, 'context_skipped');
  const malformedReportedUsage = [
    ...preselected.malformed,
    ...summaryUsed.malformed,
    ...loaded.malformed,
    ...applied.malformed,
    ...skipped.malformed,
  ];
  return {
    moduleIdentified: firstString(usage.module_identified, usage.moduleIdentified),
    preselected: preselected.rows,
    summaryUsed: summaryUsed.rows,
    reportedLoaded: [],
    reportedApplied: [],
    loaded: loaded.rows,
    applied: applied.rows,
    skipped: skipped.rows,
    validationPerformed: normalizeUsageArray(usage.validation_performed ?? usage.validationPerformed),
    usageSummary: firstString(usage.context_usage_summary, usage.usageSummary),
    extractionSources: [],
    skillBodyLoads: [],
    contextBodyLoads: [],
    unverifiedClaims: [],
    malformedReportedUsage,
    diagnostics: malformedReportedUsage.map(malformedUsageDiagnostic),
    sawUsageKeys: true,
  };
}

function emptyUsage(): ParsedUsage {
  return {
    preselected: [],
    summaryUsed: [],
    reportedLoaded: [],
    reportedApplied: [],
    loaded: [],
    applied: [],
    skipped: [],
    validationPerformed: [],
    extractionSources: [],
    skillBodyLoads: [],
    contextBodyLoads: [],
    unverifiedClaims: [],
    malformedReportedUsage: [],
    diagnostics: [],
    sawUsageKeys: false,
  };
}

function mergeUsage(a: ParsedUsage, b: ParsedUsage): ParsedUsage {
  return {
    moduleIdentified: a.moduleIdentified ?? b.moduleIdentified,
    preselected: mergeUsageArrays(a.preselected, b.preselected),
    summaryUsed: mergeUsageArrays(a.summaryUsed, b.summaryUsed),
    reportedLoaded: mergeUsageArrays(a.reportedLoaded, b.reportedLoaded),
    reportedApplied: mergeUsageArrays(a.reportedApplied, b.reportedApplied),
    loaded: mergeUsageArrays(a.loaded, b.loaded),
    applied: mergeUsageArrays(a.applied, b.applied),
    skipped: mergeUsageArrays(a.skipped, b.skipped),
    validationPerformed: mergeUsageArrays(a.validationPerformed, b.validationPerformed),
    usageSummary: a.usageSummary ?? b.usageSummary,
    extractionSources: Array.from(new Set([...a.extractionSources, ...b.extractionSources])),
    skillBodyLoads: mergeUsageArrays(a.skillBodyLoads, b.skillBodyLoads),
    contextBodyLoads: mergeUsageArrays(a.contextBodyLoads, b.contextBodyLoads),
    unverifiedClaims: mergeUsageArrays(a.unverifiedClaims, b.unverifiedClaims),
    malformedReportedUsage: mergeUsageArrays(a.malformedReportedUsage, b.malformedReportedUsage),
    diagnostics: mergeUsageArrays(a.diagnostics, b.diagnostics),
    sawUsageKeys: a.sawUsageKeys || b.sawUsageKeys,
  };
}

export function mergeUsageArrays(a: Array<Record<string, unknown>>, b: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  const merged: Array<Record<string, unknown>> = [];
  for (const item of [...a, ...b]) {
    const key = [
      item.refId,
      item.ref_id,
      item.kind,
      item.path,
      item.source,
      item.summary,
      item.reason,
      item.value,
      item.field,
      item.valuePreview,
      item.toolCallId,
    ].map((v) => String(v ?? '')).join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged;
}

function collectUsageCandidates(value: unknown, path: string, out: Array<{ source: string; value: Record<string, unknown> }>, depth = 0): void {
  if (depth > 8 || !isRecord(value)) return;
  if (isRecord(value.repo_context_usage)) out.push({ source: `${path}.repo_context_usage`, value: value.repo_context_usage });
  if (hasUsageKeys(value)) out.push({ source: path, value });
  for (const [key, child] of Object.entries(value)) {
    if (key === 'repo_context_usage') continue;
    if (isRecord(child) || Array.isArray(child)) collectUsageCandidates(child, `${path}.${key}`, out, depth + 1);
  }
}

function hasUsageKeys(value: Record<string, unknown>): boolean {
  return [
    'module_identified',
    'moduleIdentified',
    'context_preselected',
    'contextPreselected',
    'context_loaded',
    'context_applied',
    'context_skipped',
    'validation_performed',
    'contextLoaded',
    'contextApplied',
    'contextSkipped',
    'validationPerformed',
  ].some((key) => key in value);
}

function parseJsonCandidates(rawResponse?: string): Array<{ source: string; value: Record<string, unknown> }> {
  if (!rawResponse) return [];
  const candidates: Array<{ source: string; value: Record<string, unknown> }> = [];
  let idx = 0;
  for (const match of rawResponse.matchAll(/```json\s*([\s\S]*?)```/gi)) {
    try {
      const parsed = JSON.parse(match[1]);
      if (isRecord(parsed)) candidates.push({ source: `rawResponse.json_block[${idx}]`, value: parsed });
      idx += 1;
    } catch {}
  }
  if (candidates.length === 0) {
    const body = rawResponse.match(/\{[\s\S]*\}/)?.[0];
    if (body) {
      try {
        const parsed = JSON.parse(body);
        if (isRecord(parsed)) candidates.push({ source: 'rawResponse.json', value: parsed });
      } catch {}
    }
  }
  return candidates;
}

function hasUsageKeyText(rawResponse?: string): boolean {
  return /repo_context_usage|context_preselected|context_summary_used|context_loaded|context_applied|context_skipped|module_identified|validation_performed/i.test(rawResponse ?? '');
}

export function verifyContextUsageClaims(
  usage: ParsedUsage,
  packet: Record<string, unknown> | null | undefined,
): { unverifiedClaims: Array<Record<string, unknown>>; diagnostics: Array<Record<string, unknown>> } {
  const kindByRefId = knowledgeRefKindMap(packet);
  const verifiedBodyRefIds = new Set<string>();
  for (const item of [...usage.contextBodyLoads, ...usage.skillBodyLoads]) {
    const refId = firstString(item.refId, item.ref_id);
    if (refId) verifiedBodyRefIds.add(refId);
  }

  const unverifiedClaims: Array<Record<string, unknown>> = [];
  for (const item of normalizeUsageArray(usage.preselected)) {
    const refId = firstString(item.refId, item.ref_id);
    if (!refId || verifiedBodyRefIds.has(refId)) continue;
    const kind = kindByRefId.get(refId);
    if (!kind || !claimRequiresBodyLoad(kind)) continue;
    const reason = firstString(item.reason, item.summary, item.value);
    if (!contextUsageReasonImpliesReliance(reason)) continue;
    unverifiedClaims.push({
      refId,
      kind,
      claimType: 'context_preselected',
      reason: 'File-backed preselected context appears to influence work without a tool-loaded full body',
    });
  }
  for (const item of normalizeUsageArray(usage.summaryUsed)) {
    const refId = firstString(item.refId, item.ref_id);
    if (!refId || verifiedBodyRefIds.has(refId)) continue;
    const kind = kindByRefId.get(refId);
    if (!kind || !claimRequiresBodyLoad(kind)) continue;
    if (!contextUsageReasonImpliesReliance(firstString(item.reason, item.summary, item.value))) continue;
    unverifiedClaims.push({
      refId,
      kind,
      claimType: 'context_summary_used',
      reason: 'File-backed summary appears to influence work without a tool-loaded full body',
    });
  }
  for (const [claimType, rows] of [
    ['context_loaded', usage.reportedLoaded],
    ['context_applied', usage.reportedApplied],
  ] as const) {
    for (const item of normalizeUsageArray(rows)) {
      if (item.source === 'tool_call') continue;
      const refId = firstString(item.refId, item.ref_id);
      if (!refId) continue;
      const kind = kindByRefId.get(refId);
      if (!kind || !claimRequiresBodyLoad(kind)) continue;
      if (verifiedBodyRefIds.has(refId)) continue;
      unverifiedClaims.push({
        refId,
        kind,
        claimType,
        reason: `Claimed ${claimType} without matching get_repo_context_body/get_repo_skill_body call`,
      });
    }
  }

  const diagnostics = unverifiedClaims.map((claim) => ({
    code: claim.claimType === 'context_summary_used'
      ? 'context_summary_relied_without_body_load'
      : claim.claimType === 'context_preselected'
        ? 'context_preselected_relied_without_body_load'
        : 'context_claimed_without_body_load',
    severity: 'warn',
    refId: claim.refId,
    kind: claim.kind,
    claimType: claim.claimType,
    message: claim.claimType === 'context_summary_used'
      ? `${claim.refId} was reported as summary-used in a way that appears to influence work, but no body-loader context was recorded.`
      : claim.claimType === 'context_preselected'
        ? `${claim.refId} was reported as preselected context in a way that appears to influence work, but no body-loader context was recorded.`
      : `${claim.refId} was reported in ${claim.claimType} but no body-loader context was recorded.`,
  }));

  return { unverifiedClaims, diagnostics };
}

export function collectPreselectedContextFromPacket(packet: Record<string, unknown> | undefined | null): Array<Record<string, unknown>> {
  return normalizeUsageArray(packet?.selectedRefs).map((item) => ({
    refId: item.refId,
    path: item.path,
    kind: item.kind,
    title: item.title,
    source: 'runtime_preselected',
    score: item.score,
    reason: item.reason,
  }));
}

function contextUsageReasonImpliesReliance(reason?: string): boolean {
  const value = String(reason ?? '').toLowerCase();
  if (!value) return false;
  if (/relevance only|triage only|orientation only|did not rely|not rely|not used for final|not relevant|irrelevant|skipped/.test(value)) {
    return false;
  }
  return /reviewed|confirmed|used|inspected|scanned|followed|applied|pointed|directed|influence|must follow|loaded via read|loaded actual file|final work/.test(value);
}

function extractSkillBodyLoads(toolCalls?: UsageToolCall[]): Array<Record<string, unknown>> {
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls
    .filter((call) => {
      const tool = String(call.tool ?? '');
      return tool === 'get_repo_skill_body' || tool.endsWith('__get_repo_skill_body');
    })
    .map((call) => {
      const args = isRecord(call.args) ? call.args : {};
      const result = isRecord(call.result) ? call.result : {};
      return {
        refId: firstString(args.ref_id, args.refId, result.refId),
        path: firstString(args.skill_path, args.skillPath, result.path),
        kind: 'skill_body',
        source: 'tool_call',
        toolCallId: call.toolUseId,
      };
    });
}

function extractContextBodyLoads(toolCalls?: UsageToolCall[]): Array<Record<string, unknown>> {
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls
    .filter((call) => {
      const tool = String(call.tool ?? '');
      return tool === 'get_repo_context_body' || tool.endsWith('__get_repo_context_body');
    })
    .map((call) => {
      const args = isRecord(call.args) ? call.args : {};
      const result = isRecord(call.result) ? call.result : {};
      return {
        refId: firstString(args.ref_id, args.refId, result.refId),
        path: firstString(args.context_path, args.contextPath, result.path),
        kind: firstString(result.kind, args.kind) ?? 'context_body',
        source: 'tool_call',
        toolCallId: call.toolUseId,
      };
    });
}

export function normalizeUsageArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.map((v) => typeof v === 'object' && v !== null ? v as Record<string, unknown> : { value: String(v) });
}

type ContextUsageField =
  | 'context_preselected'
  | 'context_summary_used'
  | 'context_loaded'
  | 'context_applied'
  | 'context_skipped';

function normalizeReportedContextUsageArray(
  value: unknown,
  field: ContextUsageField,
): { rows: Array<Record<string, unknown>>; malformed: Array<Record<string, unknown>> } {
  if (value == null) return { rows: [], malformed: [] };
  const values = Array.isArray(value) ? value : [value];
  const rows: Array<Record<string, unknown>> = [];
  const malformed: Array<Record<string, unknown>> = [];
  for (const item of values) {
    if (!isRecord(item)) {
      malformed.push(malformedUsageRow(field, 'row_not_object', item));
      continue;
    }
    const refId = firstString(item.refId, item.ref_id);
    if (!refId) {
      malformed.push(malformedUsageRow(field, 'missing_ref_id', item));
      continue;
    }
    if ((field === 'context_loaded' || field === 'context_applied') && hasInvalidReportedLoadSource(item)) {
      malformed.push(malformedUsageRow(field, 'invalid_loaded_source', item));
      continue;
    }
    rows.push(item);
  }
  return { rows, malformed };
}

function hasInvalidReportedLoadSource(item: Record<string, unknown>): boolean {
  const source = firstString(item.source);
  if (!source) return false;
  return !['allen_system_injection', 'get_repo_context_body', 'get_repo_skill_body'].includes(source);
}

function malformedUsageRow(field: ContextUsageField, reason: string, value: unknown): Record<string, unknown> {
  return {
    field,
    reason,
    valuePreview: previewUnknown(value),
  };
}

function malformedUsageDiagnostic(item: Record<string, unknown>): Record<string, unknown> {
  const reason = firstString(item.reason);
  const field = firstString(item.field) ?? 'repo_context_usage';
  const code = reason === 'invalid_loaded_source'
    ? 'context_loaded_source_invalid'
    : reason === 'missing_ref_id'
      ? 'repo_context_usage_unmapped_claim'
      : 'repo_context_usage_malformed_row';
  return {
    code,
    severity: 'warn',
    field,
    message: reason === 'invalid_loaded_source'
      ? `${field} row used an invalid source. Only allen_system_injection, get_repo_context_body, and get_repo_skill_body are valid repo context load sources.`
      : reason === 'missing_ref_id'
        ? `${field} row did not include a refId and cannot be used for context audit or evaluation.`
        : `${field} row must be an object with a refId; string/path-only rows are ignored for context audit and evaluation.`,
    valuePreview: item.valuePreview,
  };
}

function previewUnknown(value: unknown): string {
  if (typeof value === 'string') return value.slice(0, 500);
  try {
    return JSON.stringify(value).slice(0, 500);
  } catch {
    return String(value).slice(0, 500);
  }
}

export function contextDiagnostic(
  code: string,
  severity: 'info' | 'warn',
  trace: Record<string, unknown>,
  packet: Record<string, unknown> | undefined,
  message: string,
): Record<string, unknown> {
  return {
    code,
    severity,
    executionId: String(trace.executionId ?? ''),
    nodeName: String(trace.node ?? trace.agent ?? ''),
    agentName: trace.agent,
    packetId: packet?.packetId,
    message,
  };
}

export function collectSkillBodyLoadsFromUsage(
  usageRow: Record<string, unknown> | undefined,
  executionId: string,
  nodeName: string,
  agentName: string,
): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (const item of normalizeUsageArray(usageRow?.loaded)) {
    if (item.kind === 'skill_body' || item.kind === 'skill' || item.kind === 'skill_reference') {
      rows.push({
        executionId,
        nodeName,
        agentName,
        refId: item.refId,
        path: item.path,
        source: item.source === 'allen_system_injection' ? 'allen_system_injection' : item.source === 'tool_call' ? 'tool_call' : 'reported_usage',
      });
    }
  }
  for (const item of normalizeUsageArray(usageRow?.skillBodyLoads)) {
    rows.push({
      executionId,
      nodeName,
      agentName,
      refId: item.refId,
      path: item.path,
      source: 'tool_call',
    });
  }
  return mergeUsageArrays(rows, []);
}

export function collectContextBodyLoadsFromUsage(
  usageRow: Record<string, unknown> | undefined,
  executionId: string,
  nodeName: string,
  agentName: string,
): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (const item of normalizeUsageArray(usageRow?.loaded)) {
    if ((item.source === 'tool_call' || item.source === 'allen_system_injection') && item.kind !== 'skill_body' && item.kind !== 'skill' && item.kind !== 'skill_reference') {
      rows.push({
        executionId,
        nodeName,
        agentName,
        refId: item.refId,
        path: item.path,
        kind: item.kind,
        source: 'tool_call',
      });
    }
  }
  for (const item of normalizeUsageArray(usageRow?.contextBodyLoads)) {
    rows.push({
      executionId,
      nodeName,
      agentName,
      refId: item.refId,
      path: item.path,
      kind: item.kind,
      source: 'tool_call',
    });
  }
  return mergeUsageArrays(rows, []);
}

export function knowledgeRefKindMap(packet: Record<string, unknown> | undefined | null): Map<string, string> {
  const map = new Map<string, string>();
  const refs = [
    ...normalizeUsageArray(packet?.selectedRefs),
    ...normalizeUsageArray(packet?.availableRefs),
    ...normalizeUsageArray(packet?.rejectedRefs),
  ];
  for (const ref of refs) {
    const refId = firstString(ref.refId, ref.ref_id);
    const kind = firstString(ref.kind);
    if (refId && kind) map.set(refId, kind);
  }
  return map;
}

export function addSystemInjectedContextUsage(usage: ParsedUsage, packet: Record<string, unknown> | null | undefined): void {
  const injection = isRecord(packet?.contextInjection) ? packet.contextInjection : undefined;
  const injectedRefs = normalizeUsageArray(injection?.injectedRefs).map((ref) => ({
    refId: firstString(ref.refId, ref.ref_id),
    path: firstString(ref.path),
    kind: firstString(ref.kind),
    source: 'allen_system_injection',
    reason: firstString(ref.reason) ?? 'Injected by Allen before agent startup as repo context.',
    contentSha256: firstString(ref.contentSha256),
    itemType: firstString(ref.itemType),
    grounding: firstString(ref.grounding),
  })).filter((ref) => ref.refId);
  if (injectedRefs.length === 0) return;

  usage.loaded = mergeUsageArrays(usage.loaded, injectedRefs);
  for (const ref of injectedRefs) {
    if (ref.kind === 'skill' || ref.kind === 'skill_reference') {
      usage.skillBodyLoads = mergeUsageArrays(usage.skillBodyLoads, [{ ...ref, kind: 'skill_body' }]);
    } else {
      usage.contextBodyLoads = mergeUsageArrays(usage.contextBodyLoads, [ref]);
    }
  }
}
