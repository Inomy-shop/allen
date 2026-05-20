export type WorkflowSemanticEvaluationPromptInput = {
  execution: Record<string, unknown> | null;
  descendants: Array<Record<string, unknown>>;
  nodeEvaluations: Array<Record<string, unknown>>;
  usageTraces: Array<Record<string, unknown>>;
  nodeContextPackets: Array<Record<string, unknown>>;
  executionTraces: Array<Record<string, unknown>>;
};

const MAX_JSON_CHARS = 120_000;
const OUTPUT_EXCERPT_CHARS = 900;
const MAX_REFS_PER_GROUP = 10;
const MAX_DIAGNOSTICS_PER_NODE = 8;
export const WORKFLOW_EVIDENCE_PACKING_VERSION = 2;

type EvidenceBudget = {
  excerptChars: number;
  maxRefs: number;
  maxLifecycleRows: number;
  maxDiagnostics: number;
};

export function buildWorkflowSemanticEvaluationPromptArtifacts(input: WorkflowSemanticEvaluationPromptInput): {
  prompt: string;
  evidencePayload: Record<string, unknown>;
  packedEvidencePayload: Record<string, unknown>;
  evidenceJson: string;
  evidenceTruncated: boolean;
  evidenceStats: Record<string, unknown>;
} {
  const payload = redactPayload(compactPayload(input));
  const packed = packWorkflowEvidence(payload);
  const evidenceJson = stringifyPackedEvidence(packed.payload);
  const prompt = [
    ...promptHeaderLines(),
    '',
    'Packed workflow evidence JSON:',
    evidenceJson,
  ].join('\n');
  return {
    prompt,
    evidencePayload: payload,
    packedEvidencePayload: packed.payload,
    evidenceJson,
    evidenceTruncated: packed.stats.truncated === true,
    evidenceStats: packed.stats,
  };
}

function redactPayload(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value, jsonReplacer)) as Record<string, unknown>;
}

function promptHeaderLines(): string[] {
  return [
    'You are the DeepEval semantic evaluator for Allen workflow context injection.',
    '',
    'Evaluate whether the repo context selected and injected into this workflow was precise, complete, useful, and grounded in the task.',
    'Use the deterministic node metrics as evidence, but do not copy them blindly. Judge whether the injected context actually helped the workflow output and whether important context was missed.',
    'Cognee refs are semantic recall candidates. Do not treat Cognee matches as correct just because they were recalled or selected.',
    'Distinguish candidates, selected refs, injectable refs, injected refs, provider-native refs, loaded refs, reported applied refs, and verified applied refs.',
    'Provider-native refs such as .claude/CLAUDE.md for Claude agents and AGENTS.md for Codex agents are available through runtime startup when tracked as provider_native; do not penalize them for missing Allen full-body injection.',
    'Use contextLifecycle rows to verify Cognee refs. A Cognee ref is only verified as used when it was injected, provider-native, loaded, source-discovered where applicable, or backed by applied usage evidence.',
    'System-injected refs prove availability, not usefulness. A ref is useful only when the usage trace, node output, tool evidence, or workflow artifact evidence shows it affected the work.',
    'Respect injection policies such as mandatory_full, snippet, manifest_only, and never_full_auto. Penalize manifest-only refs that were treated as loaded body context without load evidence.',
    'Context injection is meant to supply domain/spec guidance, repo practices, mandatory policies, and orientation. Investigation and implementation agents are expected to read concrete source files, tests, logs, diffs, and artifacts directly with tools.',
    'Do not penalize context injection merely because concrete source files were not injected when source discovery tool evidence shows the agent inspected them. Penalize it only when needed guideline/spec/contract/domain context was missing or noisy.',
    'Return one nodeFindings item for every agent node that had repo context injected, context usage tracked, or node context evaluation evidence. If there is not enough semantic evidence for a node, mark that node as not_assessed and explain why in the summary.',
    'Each nodeFinding MUST copy executionId, nodeName, and numeric attempt exactly from one object in Packed workflow evidence JSON.nodes.',
    'Do not append attempt text to nodeName. For example, use {"nodeName":"implement","attempt":1}, never {"nodeName":"implement attempt 1"}.',
    'For each nodeFinding, cite specific evidence from selected refs, injected refs, provider text excerpts, usage claims, node output, diagnostics, or tool evidence. Do not give only high-level conclusions.',
    'Provider-text refs are valid injected context when itemType is provider_text/provider_generated and contentExcerpt is present. Evaluate them by their excerpt, grounding, source, and usage evidence.',
    '',
    'Return only valid JSON with this shape:',
    JSON.stringify({
      status: 'passed | warning | failed',
      scores: {
        precision: 0,
        completeness: 0,
        usefulness: 0,
        groundedness: 0,
        correctness: 0,
        bloat: 0,
        overall: 0,
      },
      diagnostics: [
        {
          code: 'short_machine_code',
          severity: 'info | warn',
          message: 'specific finding',
          nodeName: 'optional node name',
          refIds: ['optional-ref-id'],
        },
      ],
      nodeFindings: [
        {
          executionId: 'execution id',
          nodeName: 'exact node name from Packed workflow evidence JSON.nodes[].nodeName',
          attempt: 1,
          status: 'passed | warning | failed | not_assessed',
          scores: {
            precision: 0,
            completeness: 0,
            usefulness: 0,
            groundedness: 0,
            correctness: 0,
            bloat: 0,
            overall: 0,
          },
          usedRefs: ['ref ids that were relevant and used'],
          missingRefs: ['ref ids or file paths that should have been present'],
          unnecessaryRefs: ['ref ids that looked irrelevant or bloated'],
          supportingEvidence: ['short concrete evidence bullets'],
          recommendation: 'specific retrieval or injection improvement',
          summary: 'specific node-level conclusion',
        },
      ],
      summary: 'workflow-level conclusion',
    }, null, 2),
    '',
    'Scoring rules:',
    '- precision: selected/injected context was relevant to the actual task and node outputs.',
    '- completeness: mandatory or clearly needed guideline/spec/contract/domain repo knowledge was present when needed; concrete source files may be satisfied by source discovery tool evidence.',
    '- usefulness: the workflow output shows the context improved decisions or implementation.',
    '- groundedness: claims about context are backed by injected refs, loaded refs, outputs, or tool evidence.',
    '- correctness: the workflow did not claim to use unavailable or contradictory context.',
    '- bloat: higher means more unnecessary context was injected.',
    '- overall: holistic quality score from 0 to 1.',
  ];
}

function compactPayload(input: WorkflowSemanticEvaluationPromptInput): Record<string, unknown> {
  return {
    execution: pick(input.execution, ['id', 'workflowName', 'status', 'input', 'state', 'failedNode', 'errorMessage', 'feedbackEntries', 'startedAt', 'completedAt']),
    descendants: input.descendants.map((row) => pick(row, ['id', 'workflowName', 'status', 'parentExecutionId', 'parentCaller', 'rootExecutionId', 'input', 'failedNode', 'errorMessage'])),
    nodeEvaluations: input.nodeEvaluations.map(compactNodeEvaluation),
    usageTraces: input.usageTraces.map(compactUsageTrace),
    nodeContextPackets: input.nodeContextPackets.map(compactNodeContextPacket),
    executionTraces: input.executionTraces.map(compactExecutionTrace),
  };
}

function compactNodeEvaluation(row: Record<string, unknown>): Record<string, unknown> {
  const out = pick(row, ['executionId', 'nodeName', 'nodeRole', 'attempt', 'status', 'scores']) ?? {};
  out.diagnostics = normalizeUsageArray(row.diagnostics).map(compactDiagnostic);
  out.refScores = normalizeUsageArray(row.refScores).map((ref) => compactRef(ref));
  out.contextLifecycle = normalizeUsageArray(row.contextLifecycle).map(slimLifecycleRow);
  out.feedbackEvidenceCount = normalizeUsageArray(row.feedbackEvidence).length;
  return out;
}

function compactUsageTrace(row: Record<string, unknown>): Record<string, unknown> {
  const out = pick(row, ['executionId', 'nodeName', 'nodeRole', 'attempt', 'packetId']) ?? {};
  out.loaded = normalizeUsageArray(row.loaded).map((ref) => compactRef(ref));
  out.claimedUsed = normalizeUsageArray(row.claimedUsed).map((ref) => compactRef(ref));
  out.reportedLoaded = normalizeUsageArray(row.reportedLoaded).map((ref) => compactRef(ref));
  out.reportedApplied = normalizeUsageArray(row.reportedApplied).map((ref) => compactRef(ref));
  out.skipped = normalizeUsageArray(row.skipped).map((ref) => compactRef(ref));
  out.validationPerformed = normalizeUsageArray(row.validationPerformed).slice(0, 8).map(compactDiagnostic);
  out.usageSummary = truncateText(firstString(row.usageSummary), 500);
  out.diagnostics = normalizeUsageArray(row.diagnostics).map(compactDiagnostic);
  return out;
}

function compactNodeContextPacket(row: Record<string, unknown>): Record<string, unknown> {
  const out = pick(row, ['executionId', 'nodeName', 'nodeRole', 'attempt', 'packetId', 'repoId', 'repoName', 'indexId', 'retrievalProviders']) ?? {};
  out.selectedRefs = normalizeUsageArray(row.selectedRefs).map((ref) => compactRef(ref));
  out.injectableRefs = normalizeUsageArray(row.injectableRefs).map((ref) => compactRef(ref));
  out.rejectedRefs = normalizeUsageArray(row.rejectedRefs).map((ref) => compactRef(ref));
  out.contextInjection = compactContextInjection(row.contextInjection);
  return out;
}

function compactContextInjection(value: unknown): Record<string, unknown> {
  const injection = isRecord(value) ? value : {};
  return {
    injectedRefs: normalizeUsageArray(injection.injectedRefs).map((ref) => compactRef(ref, { includeContent: true })),
    providerNativeRefs: normalizeUsageArray(injection.providerNativeRefs).map((ref) => compactRef(ref)),
    skippedProviderNativeRefs: normalizeUsageArray(injection.skippedProviderNativeRefs).map((ref) => compactRef(ref)),
    skippedRefs: normalizeUsageArray(injection.skippedRefs).map((ref) => compactRef(ref)),
    diagnostics: normalizeUsageArray(injection.diagnostics).map(compactDiagnostic),
  };
}

function compactExecutionTrace(row: Record<string, unknown>): Record<string, unknown> {
  const outputText = firstString(row.rawResponse, isRecord(row.output) ? JSON.stringify(row.output) : undefined);
  return {
    ...(pick(row, ['executionId', 'node', 'agent', 'attempt', 'status', 'error', 'contextUsage']) ?? {}),
    outputExcerpt: truncateText(outputText, 1_200),
    sourceDiscoveryEvidence: collectSourceDiscoveryEvidence(row).slice(0, 40),
  };
}

function compactDiagnostic(row: Record<string, unknown>): Record<string, unknown> {
  return {
    code: row.code,
    severity: row.severity,
    message: truncateText(firstString(row.message, row.summary), 400),
    refId: row.refId,
    path: row.path,
    refIds: stringArray(row.refIds).slice(0, 10),
  };
}

function compactRef(ref: Record<string, unknown>, options: { includeContent?: boolean } = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {
    refId: firstString(ref.refId, ref.ref_id, ref.id),
    path: ref.path,
    kind: ref.kind,
    title: ref.title,
    providerId: ref.providerId,
    source: ref.source,
    itemType: ref.itemType,
    grounding: ref.grounding,
    mandatory: ref.mandatory,
    reason: truncateText(firstString(ref.reason, ref.summary), 300),
    skipReason: ref.skipReason,
    score: ref.score,
    contentSha256: ref.contentSha256,
    providerMetadata: slimProviderMetadata(ref.providerMetadata),
    rerank: slimRerank(ref.rerank),
  };
  if (options.includeContent === true) {
    out.content = truncateText(firstString(ref.content), 700);
  }
  return pruneUndefined(out);
}

function packWorkflowEvidence(payload: Record<string, unknown>): { payload: Record<string, unknown>; stats: Record<string, unknown> } {
  const originalChars = JSON.stringify(payload).length;
  const sectionChars = sectionCharStats(payload);
  const attempts: EvidenceBudget[] = [
    { excerptChars: OUTPUT_EXCERPT_CHARS, maxRefs: MAX_REFS_PER_GROUP, maxLifecycleRows: 16, maxDiagnostics: MAX_DIAGNOSTICS_PER_NODE },
    { excerptChars: 500, maxRefs: 7, maxLifecycleRows: 14, maxDiagnostics: 5 },
    { excerptChars: 250, maxRefs: 4, maxLifecycleRows: 10, maxDiagnostics: 3 },
    { excerptChars: 120, maxRefs: 2, maxLifecycleRows: 8, maxDiagnostics: 2 },
    { excerptChars: 0, maxRefs: 1, maxLifecycleRows: 6, maxDiagnostics: 1 },
  ];
  for (const budget of attempts) {
    const packed = buildPackedPayload(payload, budget);
    const packedChars = JSON.stringify(packed.payload).length;
    if (packedChars <= MAX_JSON_CHARS) {
      return {
        payload: packed.payload,
        stats: {
          ...packed.stats,
          packingVersion: WORKFLOW_EVIDENCE_PACKING_VERSION,
          originalChars,
          packedChars,
          targetChars: MAX_JSON_CHARS,
          sectionChars,
          truncated: packed.stats.droppedSections.length > 0,
        },
      };
    }
  }

  const minimal = buildPackedPayload(payload, { excerptChars: 0, maxRefs: 1, maxLifecycleRows: 4, maxDiagnostics: 0 });
  const packedChars = JSON.stringify(minimal.payload).length;
  return {
    payload: minimal.payload,
    stats: {
      ...minimal.stats,
      packingVersion: WORKFLOW_EVIDENCE_PACKING_VERSION,
      originalChars,
      packedChars,
      targetChars: MAX_JSON_CHARS,
      sectionChars,
      truncated: true,
      droppedSections: [...new Set([...minimal.stats.droppedSections, 'node_details_minimized_to_lifecycle_only'])],
    },
  };
}

function buildPackedPayload(
  payload: Record<string, unknown>,
  budget: EvidenceBudget,
): { payload: Record<string, unknown>; stats: { nodeCount: number; perNode: Array<Record<string, unknown>>; droppedSections: string[] } } {
  const nodes = collectNodeEvidence(payload, budget);
  const droppedSections = new Set<string>();
  for (const node of nodes) {
    for (const section of stringArray(node.droppedSections)) droppedSections.add(section);
    delete (node as Record<string, unknown>).droppedSections;
  }
  return {
    payload: {
      execution: slimExecution(payload.execution),
      descendants: normalizeUsageArray(payload.descendants).map(slimExecution),
      nodes,
    },
    stats: {
      nodeCount: nodes.length,
      perNode: nodes.map((node) => ({
        nodeName: node.nodeName,
        attempt: node.attempt,
        selectedRefs: normalizeUsageArray(node.selectedRefs).length,
        injectableRefs: normalizeUsageArray(node.injectableRefs).length,
        injectedRefs: normalizeUsageArray(node.injectedRefs).length,
        providerNativeRefs: normalizeUsageArray(node.providerNativeRefs).length,
        skippedRefs: normalizeUsageArray(node.skippedRefs).length,
        loadedRefs: normalizeUsageArray(node.loadedRefs).length,
        appliedRefs: normalizeUsageArray(node.appliedRefs).length,
        reportedAppliedRefs: normalizeUsageArray(node.reportedAppliedRefs).length,
        reportedLoadedRefs: normalizeUsageArray(node.reportedLoadedRefs).length,
        sourceDiscoveryEvidence: normalizeUsageArray(node.sourceDiscoveryEvidence).length,
        contextLifecycle: normalizeUsageArray(node.contextLifecycle).length,
        diagnostics: normalizeUsageArray(node.diagnostics).length,
        outputExcerptChars: String(node.outputExcerpt ?? '').length,
      })),
      droppedSections: Array.from(droppedSections),
    },
  };
}

function collectNodeEvidence(
  payload: Record<string, unknown>,
  budget: EvidenceBudget,
): Array<Record<string, unknown>> {
  const nodes = new Map<string, Record<string, unknown>>();
  const ensure = (executionId: unknown, nodeName: unknown, attempt: unknown): Record<string, unknown> => {
    const node = String(nodeName ?? 'unknown');
    const attemptValue = Number(attempt ?? 1);
    const key = `${String(executionId ?? '')}:${node}:${attemptValue}`;
    const existing = nodes.get(key);
    if (existing) return existing;
    const row = {
      executionId,
      nodeName: node,
      attempt: attemptValue,
      selectedRefs: [],
      injectableRefs: [],
      injectedRefs: [],
      providerNativeRefs: [],
      skippedRefs: [],
      loadedRefs: [],
      appliedRefs: [],
      reportedAppliedRefs: [],
      reportedLoadedRefs: [],
      rejectedRefs: [],
      contextLifecycle: [],
      sourceDiscoveryEvidence: [],
      diagnostics: [],
      droppedSections: [],
      _lifecycleSelectedRefs: [],
      _lifecycleInjectableRefs: [],
      _lifecycleInjectedRefs: [],
      _lifecycleProviderNativeRefs: [],
      _lifecycleLoadedRefs: [],
      _lifecycleAppliedRefs: [],
      _lifecycleRejectedRefs: [],
      _lifecycleSkippedRefs: [],
    };
    nodes.set(key, row);
    return row;
  };

  for (const packet of normalizeUsageArray(payload.nodeContextPackets)) {
    const node = ensure(packet.executionId, packet.nodeName, packet.attempt);
    node.nodeRole ??= packet.nodeRole;
    node.repoName ??= packet.repoName;
    node.indexId ??= packet.indexId;
    node.packetId ??= packet.packetId;
    node.retrievalProviders ??= packet.retrievalProviders;
    const selectedRefs = normalizeUsageArray(packet.selectedRefs);
    const injectableRefs = normalizeUsageArray(packet.injectableRefs);
    const rejectedRefs = normalizeUsageArray(packet.rejectedRefs);
    appendLifecycleRefs(node, '_lifecycleSelectedRefs', selectedRefs);
    appendLifecycleRefs(node, '_lifecycleInjectableRefs', injectableRefs);
    appendLifecycleRefs(node, '_lifecycleRejectedRefs', rejectedRefs);
    assignCappedRefs(node, 'selectedRefs', selectedRefs, budget.maxRefs);
    assignCappedRefs(node, 'injectableRefs', injectableRefs, budget.maxRefs);
    assignCappedRefs(node, 'rejectedRefs', rejectedRefs, budget.maxRefs);
    const injection = isRecord(packet.contextInjection) ? packet.contextInjection : {};
    const injectedRefs = normalizeUsageArray(injection.injectedRefs);
    const providerNativeRefs = [
      ...normalizeUsageArray(injection.skippedProviderNativeRefs),
      ...normalizeUsageArray(injection.providerNativeRefs),
    ];
    const skippedRefs = normalizeUsageArray(injection.skippedRefs);
    appendLifecycleRefs(node, '_lifecycleInjectedRefs', injectedRefs);
    appendLifecycleRefs(node, '_lifecycleProviderNativeRefs', providerNativeRefs);
    appendLifecycleRefs(node, '_lifecycleSkippedRefs', skippedRefs);
    assignCappedRefs(node, 'injectedRefs', injectedRefs, budget.maxRefs);
    assignCappedRefs(node, 'providerNativeRefs', providerNativeRefs, budget.maxRefs);
    assignCappedRefs(node, 'skippedRefs', skippedRefs, budget.maxRefs);
    rebuildNodeContextLifecycle(node, budget.maxLifecycleRows);
  }

  for (const usage of normalizeUsageArray(payload.usageTraces)) {
    const node = ensure(usage.executionId, usage.nodeName, usage.attempt);
    node.nodeRole ??= usage.nodeRole;
    node.packetId ??= usage.packetId;
    const loadedRefs = normalizeUsageArray(usage.loaded);
    const appliedRefs = normalizeUsageArray(usage.claimedUsed);
    const reportedLoadedRefs = normalizeUsageArray(usage.reportedLoaded);
    const reportedAppliedRefs = normalizeUsageArray(usage.reportedApplied);
    appendLifecycleRefs(node, '_lifecycleLoadedRefs', [...loadedRefs, ...reportedLoadedRefs]);
    appendLifecycleRefs(node, '_lifecycleAppliedRefs', [...appliedRefs, ...reportedAppliedRefs]);
    assignCappedRefs(node, 'loadedRefs', loadedRefs, budget.maxRefs);
    assignCappedRefs(node, 'appliedRefs', appliedRefs, budget.maxRefs);
    assignCappedRefs(node, 'reportedLoadedRefs', reportedLoadedRefs, budget.maxRefs);
    assignCappedRefs(node, 'reportedAppliedRefs', reportedAppliedRefs, budget.maxRefs);
    node.validationPerformed = normalizeUsageArray(usage.validationPerformed).slice(0, 5);
    node.usageSummary = truncateText(firstString(usage.usageSummary), 500);
    appendDiagnostics(node, normalizeUsageArray(usage.diagnostics), budget.maxDiagnostics);
    rebuildNodeContextLifecycle(node, budget.maxLifecycleRows);
  }

  for (const evaluation of normalizeUsageArray(payload.nodeEvaluations)) {
    const node = ensure(evaluation.executionId, evaluation.nodeName, evaluation.attempt);
    node.nodeRole ??= evaluation.nodeRole;
    node.evaluationStatus = evaluation.status;
    node.scores = evaluation.scores;
    appendDiagnostics(node, normalizeUsageArray(evaluation.diagnostics), budget.maxDiagnostics);
    assignCappedRefs(node, 'refScores', normalizeUsageArray(evaluation.refScores), budget.maxRefs);
    const evaluationLifecycle = normalizeUsageArray(evaluation.contextLifecycle);
    if (evaluationLifecycle.length > 0) {
      node.contextLifecycle = [];
      assignCappedLifecycleRows(node, evaluationLifecycle, budget.maxLifecycleRows);
      node._contextLifecyclePinned = true;
    }
    node.feedbackEvidenceCount = normalizeUsageArray(evaluation.feedbackEvidence).length;
  }

  for (const trace of normalizeUsageArray(payload.executionTraces)) {
    const node = ensure(trace.executionId, trace.node, trace.attempt);
    node.agent ??= trace.agent;
    node.status ??= trace.status;
    node.contextUsage ??= trace.contextUsage;
    node.error ??= truncateText(firstString(trace.error), 500);
    node.sourceDiscoveryEvidence = [
      ...normalizeUsageArray(trace.sourceDiscoveryEvidence),
      ...collectSourceDiscoveryEvidence(trace),
    ].slice(0, budget.maxRefs);
    if (node._contextLifecyclePinned !== true) rebuildNodeContextLifecycle(node, budget.maxLifecycleRows);
    const outputText = firstString(trace.outputExcerpt, trace.rawResponse, isRecord(trace.output) ? JSON.stringify(trace.output) : undefined);
    node.outputExcerpt = budget.excerptChars > 0 ? truncateText(outputText, budget.excerptChars) : undefined;
    if (outputText && outputText.length > budget.excerptChars) addDroppedSection(node, 'output_excerpt_truncated');
  }

  return Array.from(nodes.values()).map((node) => {
    delete node._contextLifecyclePinned;
    delete node._lifecycleSelectedRefs;
    delete node._lifecycleInjectableRefs;
    delete node._lifecycleInjectedRefs;
    delete node._lifecycleProviderNativeRefs;
    delete node._lifecycleLoadedRefs;
    delete node._lifecycleAppliedRefs;
    delete node._lifecycleRejectedRefs;
    delete node._lifecycleSkippedRefs;
    return node;
  }).sort((a, b) => {
    const exec = String(a.executionId ?? '').localeCompare(String(b.executionId ?? ''));
    if (exec !== 0) return exec;
    const node = String(a.nodeName ?? '').localeCompare(String(b.nodeName ?? ''));
    if (node !== 0) return node;
    return Number(a.attempt ?? 0) - Number(b.attempt ?? 0);
  });
}

function slimExecution(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  return pick(value, ['id', 'workflowName', 'status', 'input', 'failedNode', 'errorMessage', 'feedbackEntries', 'startedAt', 'completedAt']);
}

function assignCappedRefs(target: Record<string, unknown>, key: string, refs: Array<Record<string, unknown>>, maxRefs: number): void {
  const existing = normalizeUsageArray(target[key]);
  const slim = refs
    .slice()
    .sort((a, b) => refSignalScore(b) - refSignalScore(a))
    .slice(0, maxRefs)
    .map(slimRef);
  target[key] = [...existing, ...slim].slice(0, maxRefs);
  if (refs.length > maxRefs) addDroppedSection(target, `${key}_truncated`);
}

function appendLifecycleRefs(target: Record<string, unknown>, key: string, refs: Array<Record<string, unknown>>): void {
  target[key] = [...normalizeUsageArray(target[key]), ...refs];
}

function rebuildNodeContextLifecycle(node: Record<string, unknown>, maxRefs: number): void {
  node.contextLifecycle = [];
  assignCappedLifecycleRows(node, buildContextLifecycle({
    selectedRefs: normalizeUsageArray(node._lifecycleSelectedRefs).length > 0 ? normalizeUsageArray(node._lifecycleSelectedRefs) : normalizeUsageArray(node.selectedRefs),
    injectableRefs: normalizeUsageArray(node._lifecycleInjectableRefs).length > 0 ? normalizeUsageArray(node._lifecycleInjectableRefs) : normalizeUsageArray(node.injectableRefs),
    injectedRefs: normalizeUsageArray(node._lifecycleInjectedRefs).length > 0 ? normalizeUsageArray(node._lifecycleInjectedRefs) : normalizeUsageArray(node.injectedRefs),
    providerNativeRefs: normalizeUsageArray(node._lifecycleProviderNativeRefs).length > 0 ? normalizeUsageArray(node._lifecycleProviderNativeRefs) : normalizeUsageArray(node.providerNativeRefs),
    loadedRefs: normalizeUsageArray(node._lifecycleLoadedRefs).length > 0 ? normalizeUsageArray(node._lifecycleLoadedRefs) : [
      ...normalizeUsageArray(node.loadedRefs),
      ...normalizeUsageArray(node.reportedLoadedRefs),
    ],
    appliedRefs: normalizeUsageArray(node._lifecycleAppliedRefs).length > 0 ? normalizeUsageArray(node._lifecycleAppliedRefs) : [
      ...normalizeUsageArray(node.appliedRefs),
      ...normalizeUsageArray(node.reportedAppliedRefs),
    ],
    rejectedRefs: normalizeUsageArray(node._lifecycleRejectedRefs).length > 0 ? normalizeUsageArray(node._lifecycleRejectedRefs) : normalizeUsageArray(node.rejectedRefs),
    skippedRefs: normalizeUsageArray(node._lifecycleSkippedRefs).length > 0 ? normalizeUsageArray(node._lifecycleSkippedRefs) : normalizeUsageArray(node.skippedRefs),
    sourceDiscovery: normalizeUsageArray(node.sourceDiscoveryEvidence),
  }), maxRefs);
}

function assignCappedLifecycleRows(target: Record<string, unknown>, refs: Array<Record<string, unknown>>, maxRefs: number): void {
  const existing = normalizeUsageArray(target.contextLifecycle);
  const slim = refs
    .slice()
    .sort((a, b) => lifecycleSignalScore(b) - lifecycleSignalScore(a))
    .slice(0, maxRefs)
    .map(slimLifecycleRow);
  target.contextLifecycle = [...existing, ...slim].slice(0, maxRefs);
  if (refs.length > maxRefs) addDroppedSection(target, 'contextLifecycle_truncated');
}

function refSignalScore(ref: Record<string, unknown>): number {
  const metadata = isRecord(ref.providerMetadata) ? ref.providerMetadata : {};
  const injectionDecision = String(metadata.injectionDecision ?? metadata.injectionPolicy ?? '');
  const rerank = isRecord(ref.rerank) ? ref.rerank : {};
  const itemType = String(ref.itemType ?? '');
  let score = 0;
  if (ref.mandatory === true) score += 100;
  if (injectionDecision === 'mandatory_full') score += 80;
  if (injectionDecision === 'snippet') score += 50;
  if (injectionDecision === 'manifest_only') score += 25;
  if (injectionDecision === 'never_full_auto') score -= 20;
  if (itemType === 'repo_file') score += 20;
  if (itemType === 'repo_chunk') score += 10;
  if (ref.providerId === 'mandatory_graph') score += 20;
  if (ref.providerId === 'cognee_memory') score += 5;
  score += Number(rerank.score ?? ref.score ?? 0);
  return score;
}

function lifecycleSignalScore(ref: Record<string, unknown>): number {
  let score = Number(ref.score ?? 0);
  if (ref.applied === true) score += 100;
  if (ref.loaded === true) score += 80;
  if (ref.injected === true) score += 60;
  if (ref.providerNative === true) score += 50;
  if (ref.injectable === true) score += 40;
  if (ref.selected === true) score += 30;
  if (ref.sourceDiscovered === true) score += 25;
  if (ref.skipped === true) score -= 10;
  if (ref.rejected === true) score -= 20;
  if (ref.providerId === 'mandatory_graph') score += 20;
  if (ref.providerId === 'cognee_memory') score += 5;
  if (firstString(ref.cogneeChunkId)) score += 5;
  return score;
}

function slimRef(ref: Record<string, unknown>): Record<string, unknown> {
  return {
    refId: ref.refId,
    path: ref.path,
    kind: ref.kind,
    title: ref.title,
    providerId: ref.providerId,
    source: ref.source,
    itemType: ref.itemType,
    grounding: ref.grounding,
    mandatory: ref.mandatory,
    reason: truncateText(firstString(ref.reason, ref.summary), 300),
    skipReason: ref.skipReason,
    score: ref.score,
    contentSha256: ref.contentSha256,
    contentExcerpt: truncateText(firstString(ref.content), 1000),
    providerMetadata: slimProviderMetadata(ref.providerMetadata),
    rerank: slimRerank(ref.rerank),
  };
}

function sectionCharStats(payload: Record<string, unknown>): Record<string, number> {
  return {
    execution: JSON.stringify(payload.execution ?? null).length,
    descendants: JSON.stringify(payload.descendants ?? []).length,
    nodeEvaluations: JSON.stringify(payload.nodeEvaluations ?? []).length,
    usageTraces: JSON.stringify(payload.usageTraces ?? []).length,
    nodeContextPackets: JSON.stringify(payload.nodeContextPackets ?? []).length,
    executionTraces: JSON.stringify(payload.executionTraces ?? []).length,
  };
}

function pruneUndefined(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) out[key] = item;
  }
  return out;
}

function slimLifecycleRow(ref: Record<string, unknown>): Record<string, unknown> {
  return {
    refId: ref.refId,
    providerId: ref.providerId,
    path: ref.path,
    kind: ref.kind,
    itemType: ref.itemType,
    title: ref.title,
    selected: ref.selected === true,
    injectable: ref.injectable === true,
    injected: ref.injected === true,
    providerNative: ref.providerNative === true,
    loaded: ref.loaded === true,
    applied: ref.applied === true,
    sourceDiscovered: ref.sourceDiscovered === true,
    rejected: ref.rejected === true,
    skipped: ref.skipped === true,
    skipReason: ref.skipReason,
    injectionDecision: ref.injectionDecision,
    datasetName: ref.datasetName,
    cogneeChunkId: ref.cogneeChunkId,
    cogneeDataId: ref.cogneeDataId,
    chunkIndex: ref.chunkIndex,
    contentSha256: ref.contentSha256,
    reason: truncateText(firstString(ref.reason), 260),
    score: ref.score,
  };
}

function slimProviderMetadata(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const slim = pick(value, [
    'datasetId',
    'datasetName',
    'sourceId',
    'chunkId',
    'cogneeChunkId',
    'chunkIndex',
    'chunkSize',
    'cutType',
    'documentRole',
    'containsCodeBlocks',
    'entityIds',
    'confidence',
    'searchMode',
    'latencyMs',
    'injectionDecision',
    'injectionPolicy',
    'cogneeDataId',
  ]) ?? {};
  const sourceMetadata = slimSourceMetadata(value.sourceMetadata);
  if (sourceMetadata) slim.sourceMetadata = sourceMetadata;
  return Object.keys(slim).length > 0 ? slim : undefined;
}

function slimSourceMetadata(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const slim = pick(value, ['repoId', 'repoName', 'branch', 'headSha', 'path', 'title', 'kind', 'fileHash', 'ingestFormat', 'source']) ?? {};
  return Object.keys(slim).length > 0 ? slim : undefined;
}

function slimRerank(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  return pick(value, ['providerId', 'score', 'originalRank', 'finalRank', 'reason', 'mandatoryProtected']) ?? undefined;
}

function collectSourceDiscoveryEvidence(trace: Record<string, unknown>): Array<Record<string, unknown>> {
  return normalizeUsageArray(trace.toolCalls)
    .flatMap((call): Array<Record<string, unknown>> => {
      const tool = firstString(call.tool, call.name);
      if (!tool || !isSourceDiscoveryTool(tool, call)) return [];
      const args = isRecord(call.args) ? call.args : {};
      const command = firstString(args.command, args.cmd, call.command, call.content);
      return [{
        tool,
        paths: extractToolPaths(args, call).slice(0, 12),
        commandPreview: truncateText(command, 240),
        toolUseId: firstString(call.toolUseId, call.toolCallId, call.id),
      }];
    });
}

function isSourceDiscoveryTool(tool: string, call: Record<string, unknown>): boolean {
  const lower = tool.toLowerCase();
  if (/(^|__)(read|grep|glob|ls|find)$/.test(lower)) return true;
  if (/(^|__)(bash|shell|exec_command)$/.test(lower)) {
    const args = isRecord(call.args) ? call.args : {};
    const command = firstString(args.command, args.cmd, call.command, call.content) ?? '';
    return /\b(rg|grep|find|ls|sed|cat|head|tail|git\s+(show|diff|grep))\b/.test(command);
  }
  return false;
}

function extractToolPaths(args: Record<string, unknown>, call: Record<string, unknown>): string[] {
  const values = [
    args.path,
    args.file_path,
    args.filePath,
    args.absolute_path,
    args.relative_path,
    args.relativePath,
    args.glob,
    args.pattern,
    call.path,
  ];
  const paths = values.flatMap((value) => typeof value === 'string' ? [value] : Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
  const command = firstString(args.command, args.cmd, call.command, call.content);
  if (command) paths.push(...extractPathLikeTokens(command));
  return Array.from(new Set(paths.map((path) => path.trim()).filter(Boolean)));
}

function extractPathLikeTokens(command: string): string[] {
  const matches = command.match(/[A-Za-z0-9_./@-]+\.(?:ts|tsx|js|jsx|py|java|go|rs|rb|php|css|scss|html|json|ya?ml|md|sql|sh|bash|zsh|toml|ini)|(?:^|\s)(?:src|packages|apps|tests|test|docs|e2e|\.claude|\.github)\/[A-Za-z0-9_./@-]+/g) ?? [];
  return matches.map((match) => match.trim());
}

function buildContextLifecycle(input: {
  selectedRefs: Array<Record<string, unknown>>;
  injectableRefs: Array<Record<string, unknown>>;
  injectedRefs: Array<Record<string, unknown>>;
  providerNativeRefs: Array<Record<string, unknown>>;
  loadedRefs: Array<Record<string, unknown>>;
  appliedRefs: Array<Record<string, unknown>>;
  rejectedRefs: Array<Record<string, unknown>>;
  skippedRefs: Array<Record<string, unknown>>;
  sourceDiscovery: Array<Record<string, unknown>>;
}): Array<Record<string, unknown>> {
  const rows = new Map<string, Record<string, unknown>>();
  const ensure = (ref: Record<string, unknown>): Record<string, unknown> | null => {
    const id = firstString(ref.refId, ref.ref_id, ref.id);
    if (!id) return null;
    const existing = rows.get(id) ?? lifecycleBase(ref);
    rows.set(id, existing);
    return existing;
  };
  for (const ref of input.selectedRefs) {
    const row = ensure(ref);
    if (row) row.selected = true;
  }
  for (const ref of input.injectableRefs) {
    const row = ensure(ref);
    if (row) row.injectable = true;
  }
  for (const ref of input.injectedRefs) {
    const row = ensure(ref);
    if (row) row.injected = true;
  }
  for (const ref of input.providerNativeRefs) {
    const row = ensure(ref);
    if (row) {
      row.providerNative = true;
      row.skipReason ??= 'provider_native';
    }
  }
  for (const ref of input.loadedRefs) {
    const row = ensure(ref);
    if (row) row.loaded = true;
  }
  for (const ref of input.appliedRefs) {
    const row = ensure(ref);
    if (row) row.applied = true;
  }
  for (const ref of input.rejectedRefs) {
    const row = ensure(ref);
    if (row) row.rejected = true;
  }
  for (const ref of input.skippedRefs) {
    const row = ensure(ref);
    if (row) {
      row.skipped = true;
      row.skipReason ??= firstString(ref.skipReason);
    }
  }
  for (const ref of input.selectedRefs) {
    const id = firstString(ref.refId, ref.ref_id, ref.id);
    const row = id ? rows.get(id) : undefined;
    if (row && sourceDiscoverySatisfiesRef(ref, input.sourceDiscovery)) row.sourceDiscovered = true;
  }
  return Array.from(rows.values()).map((row) => ({
    selected: false,
    injectable: false,
    injected: false,
    providerNative: false,
    loaded: false,
    applied: false,
    sourceDiscovered: false,
    rejected: false,
    skipped: false,
    ...row,
  }));
}

function lifecycleBase(ref: Record<string, unknown>): Record<string, unknown> {
  const metadata = isRecord(ref.providerMetadata) ? ref.providerMetadata : {};
  const sourceMetadata = isRecord(metadata.sourceMetadata) ? metadata.sourceMetadata : {};
  return {
    refId: firstString(ref.refId, ref.ref_id, ref.id),
    providerId: firstString(ref.providerId),
    path: firstString(ref.path, sourceMetadata.path),
    kind: firstString(ref.kind),
    itemType: firstString(ref.itemType),
    title: firstString(ref.title),
    reason: truncateText(firstString(ref.reason, ref.summary), 260),
    skipReason: firstString(ref.skipReason),
    score: ref.score,
    injectionDecision: firstString(metadata.injectionDecision, metadata.injectionPolicy),
    datasetName: firstString(metadata.datasetName),
    cogneeChunkId: firstString(metadata.cogneeChunkId, metadata.chunkId),
    cogneeDataId: firstString(metadata.cogneeDataId, sourceMetadata.cogneeDataId),
    chunkIndex: metadata.chunkIndex,
    contentSha256: firstString(ref.contentSha256),
  };
}

function sourceDiscoverySatisfiesRef(ref: Record<string, unknown>, evidence: Array<Record<string, unknown>>): boolean {
  const path = firstString(ref.path);
  if (!path || evidence.length === 0) return false;
  const normalizedPath = normalizeRepoPath(path);
  const basename = normalizedPath.split('/').pop();
  return evidence.some((item) => {
    const paths = Array.isArray(item.paths) ? item.paths.filter((value): value is string => typeof value === 'string') : [];
    const command = firstString(item.commandPreview) ?? '';
    return paths.some((candidate) => pathsOverlap(normalizedPath, normalizeRepoPath(candidate)))
      || command.includes(path)
      || Boolean(basename && command.includes(basename));
  });
}

function pathsOverlap(a: string, b: string): boolean {
  if (!a || !b) return false;
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`) || a.includes(`/${b}/`) || b.includes(`/${a}/`);
}

function normalizeRepoPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^.*?((?:packages|apps|src|tests?|e2e|docs|\.claude|\.github)\/)/, '$1').replace(/^\.\//, '');
}

function appendDiagnostics(target: Record<string, unknown>, diagnostics: Array<Record<string, unknown>>, maxDiagnostics: number): void {
  const existing = normalizeUsageArray(target.diagnostics);
  target.diagnostics = [...existing, ...diagnostics.slice(0, maxDiagnostics).map((diag) => ({
    code: diag.code,
    severity: diag.severity,
    message: truncateText(firstString(diag.message, diag.summary), 400),
    refId: diag.refId,
    path: diag.path,
    refIds: normalizeUsageArray(diag.refIds).slice(0, 10),
  }))].slice(0, maxDiagnostics);
  if (diagnostics.length > maxDiagnostics) addDroppedSection(target, 'diagnostics_truncated');
}

function addDroppedSection(target: Record<string, unknown>, section: string): void {
  const dropped = stringArray(target.droppedSections);
  if (!dropped.includes(section)) dropped.push(section);
  target.droppedSections = dropped;
}

function pick(row: Record<string, unknown> | null | undefined, keys: string[]): Record<string, unknown> | null {
  if (!row) return null;
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (row[key] !== undefined) out[key] = row[key];
  }
  return out;
}

function stringifyPackedEvidence(value: unknown): string {
  const text = JSON.stringify(value, jsonReplacer, 2);
  if (text.length <= MAX_JSON_CHARS) return text;
  return JSON.stringify({
    warning: 'Packed evidence exceeded prompt budget even after minimization.',
    targetChars: MAX_JSON_CHARS,
    evidenceChars: text.length,
    evidence: value,
  }, jsonReplacer, 2).slice(0, MAX_JSON_CHARS);
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (/secret|token|password|credential|api[_-]?key|jwt|authorization/i.test(_key)) return '[redacted]';
  if (typeof value === 'string' && value.length > 6000) return `${value.slice(0, 6000)}...[truncated]`;
  return value;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeUsageArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function truncateText(value: string | undefined, maxChars: number): string | undefined {
  if (!value) return undefined;
  if (maxChars <= 0) return undefined;
  return value.length > maxChars ? `${value.slice(0, maxChars)}...[truncated]` : value;
}
