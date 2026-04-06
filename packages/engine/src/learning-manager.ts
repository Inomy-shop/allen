import type { Db, Collection, ObjectId } from 'mongodb';
import type { Learning, LearningType, WorkflowDef } from './types.js';

// ── Extraction Context ─────────────────────────────────────────────────────

export interface ExtractionContext {
  executionId: string;
  workflowName: string;
  contextTags: string[];
  nodeName: string;
}

// ── Constants ──────────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'to', 'of',
  'in', 'for', 'on', 'with', 'at', 'by', 'from', 'it', 'this', 'that',
  'and', 'or', 'not', 'but', 'if', 'then', 'else', 'when', 'so', 'as',
  'has', 'have', 'had', 'do', 'does', 'did', 'will', 'would', 'should',
  'could', 'can', 'may', 'might', 'shall',
]);

const GROWTH_LIMITS: Record<string, number> = {
  global: 200,
  workflow: 100,
  context: 500,
  role: 50,
  node_pattern: 50,
};

const SCOPE_SPECIFICITY: Record<string, number> = {
  context: 1.0,
  workflow: 0.8,
  node_pattern: 0.7,
  role: 0.6,
  global: 0.4,
};

// ── Learning Manager ───────────────────────────────────────────────────────

export class LearningManager {
  private collection: Collection<Learning>;
  private db: Db;

  constructor(db: Db) {
    this.db = db;
    this.collection = db.collection<Learning>('learnings');
  }

  // ── Keyword Extraction ─────────────────────────────────────────────────

  extractKeywords(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !STOPWORDS.has(w));
  }

  // ── Token Estimation ───────────────────────────────────────────────────

  estimateTokens(text: string): number {
    return Math.ceil(text.split(/\s+/).length * 1.3);
  }

  // ── Similarity Detection ───────────────────────────────────────────────

  async findSimilar(
    content: string,
    scope: Learning['scope'],
  ): Promise<Array<{ item: Learning; score: number }>> {
    const filter: Record<string, unknown> = {
      'scope.level': scope.level,
      status: 'active',
    };

    if (scope.level === 'workflow' && scope.workflowName) {
      filter['scope.workflowName'] = scope.workflowName;
    }
    if (scope.level === 'context' && scope.contextTags) {
      filter['scope.contextTags'] = { $all: scope.contextTags };
    }
    if (scope.level === 'role' && scope.roleName) {
      filter['scope.roleName'] = scope.roleName;
    }
    if (scope.level === 'node_pattern' && scope.nodePattern) {
      filter['scope.nodePattern'] = scope.nodePattern;
    }

    const candidates = await this.collection.find(filter).limit(100).toArray();
    const newKeywords = this.extractKeywords(content);

    return candidates
      .map(item => {
        const existingKeywords = this.extractKeywords(item.content);
        const intersection = newKeywords.filter(k => existingKeywords.includes(k));
        const union = new Set([...newKeywords, ...existingKeywords]);
        const score = union.size > 0 ? intersection.length / union.size : 0;
        return { item, score };
      })
      .filter(r => r.score > 0.3)
      .sort((a, b) => b.score - a.score)
      .slice(0, 20);
  }

  // ── Contradiction Detection ────────────────────────────────────────────

  contradicts(newLearning: Learning, existing: Learning): boolean {
    const newContent = newLearning.content.toLowerCase();
    const existingContent = existing.content.toLowerCase();

    // Pattern 1: Negation detection
    const negationPatterns: Array<[RegExp, RegExp]> = [
      [/don'?t use (.+)/, /use (.+)/],
      [/not (.+)/, /(.+)/],
      [/never (.+)/, /always (.+)/],
      [/is not (.+)/, /is (.+)/],
    ];

    for (const [negPattern, posPattern] of negationPatterns) {
      if (negPattern.test(newContent) && posPattern.test(existingContent)) return true;
      if (posPattern.test(newContent) && negPattern.test(existingContent)) return true;
    }

    // Pattern 2: Conflicting numbers
    const newNumbers: string[] = newContent.match(/\b\d+\b/g) ?? [];
    const existingNumbers: string[] = existingContent.match(/\b\d+\b/g) ?? [];
    const newKw = this.extractKeywords(newContent);
    const existingKw = this.extractKeywords(existingContent);
    const overlap = newKw.filter(k => existingKw.includes(k));

    if (overlap.length > 3 && newNumbers.length > 0 && existingNumbers.length > 0) {
      const numbersMatch = newNumbers.some(n => existingNumbers.includes(n));
      if (!numbersMatch) return true;
    }

    // Pattern 3: Same verb different object
    const usesPattern = /\b(uses?|runs?|requires?|needs?)\s+(\w+)/;
    const newMatch = newContent.match(usesPattern);
    const existingMatch = existingContent.match(usesPattern);
    if (newMatch && existingMatch && newMatch[1] === existingMatch[1] && newMatch[2] !== existingMatch[2]) {
      if (overlap.length >= 2) return true;
    }

    return false;
  }

  // ── Classification & Storage ───────────────────────────────────────────

  async classifyAndStore(learning: Learning): Promise<void> {
    try {
      learning.tokenCount = this.estimateTokens(learning.content);

      const existing = await this.findSimilar(learning.content, learning.scope);

      if (existing.length === 0) {
        await this.enforceGrowthLimits(learning.scope);
        const result = await this.collection.insertOne(learning);
        this.generateEmbedding(result.insertedId.toString(), learning.content);
        return;
      }

      const { item: mostSimilar, score: similarity } = existing[0];

      if (similarity > 0.95) {
        await this.confirm(mostSimilar._id, learning.source.executionId);
        return;
      }

      if (similarity > 0.7 && !this.contradicts(learning, mostSimilar)) {
        await this.collection.updateOne(
          { _id: mostSimilar._id },
          { $set: { content: learning.content, updatedAt: new Date() }, $inc: { confirmations: 1 } },
        );
        // Re-embed since content changed
        this.generateEmbedding(mostSimilar._id.toString(), learning.content);
        return;
      }

      if (this.contradicts(learning, mostSimilar)) {
        await this.collection.updateOne(
          { _id: mostSimilar._id },
          { $set: { status: 'superseded' as const, supersededBy: learning._id, supersededAt: new Date() } },
        );
        const result = await this.collection.insertOne(learning);
        this.generateEmbedding(result.insertedId.toString(), learning.content);
        return;
      }

      await this.enforceGrowthLimits(learning.scope);
      const result = await this.collection.insertOne(learning);
      this.generateEmbedding(result.insertedId.toString(), learning.content);
    } catch (err) {
      console.error('Learning storage failed (non-blocking):', err);
    }
  }

  /** Generate embedding for a learning (fire-and-forget). */
  private generateEmbedding(learningId: string, content: string): void {
    import('./embedding.js').then(({ embedAndSave }) => {
      embedAndSave(this.db, learningId, content).catch(() => {});
    }).catch(() => {});
  }

  // ── Growth Limits ──────────────────────────────────────────────────────

  async enforceGrowthLimits(scope: Learning['scope']): Promise<void> {
    const limit = GROWTH_LIMITS[scope.level] ?? 500;

    const filter: Record<string, unknown> = {
      'scope.level': scope.level,
      status: 'active',
    };

    if (scope.level === 'workflow' && scope.workflowName) {
      filter['scope.workflowName'] = scope.workflowName;
    }
    if (scope.level === 'context' && scope.contextTags) {
      filter['scope.contextTags'] = { $all: scope.contextTags };
    }
    if (scope.level === 'role' && scope.roleName) {
      filter['scope.roleName'] = scope.roleName;
    }
    if (scope.level === 'node_pattern' && scope.nodePattern) {
      filter['scope.nodePattern'] = scope.nodePattern;
    }

    const count = await this.collection.countDocuments(filter);

    if (count >= limit) {
      const weakest = await this.collection.findOne(
        filter,
        { sort: { confidence: 1, lastUsedAt: 1 } },
      );
      if (weakest) {
        await this.collection.updateOne(
          { _id: weakest._id },
          { $set: { status: 'archived' as const } },
        );
      }
    }
  }

  // ── Confirmation / Contradiction ───────────────────────────────────────

  async confirm(learningId: any, executionId: string): Promise<void> {
    // Atomic: increment confirmations + bump confidence by 0.1 (capped at 0.95 in-memory post-read)
    // Use $inc for confirmations, then cap confidence in a single pipeline
    await this.collection.updateOne(
      { _id: learningId, confidence: { $lt: 0.95 } },
      {
        $inc: { confirmations: 1, confidence: 0.1 },
        $set: { lastConfirmedAt: new Date(), updatedAt: new Date() },
      },
    );
    // Cap confidence at 0.95 (if $inc pushed it over)
    await this.collection.updateOne(
      { _id: learningId, confidence: { $gt: 0.95 } },
      { $set: { confidence: 0.95 } },
    );
  }

  async contradict(learningId: any, executionId: string): Promise<void> {
    const doc = await this.collection.findOne({ _id: learningId });
    if (!doc) return;

    const newContradictions = doc.contradictions + 1;
    if (newContradictions > doc.confirmations) {
      await this.collection.updateOne(
        { _id: learningId },
        {
          $inc: { contradictions: 1 },
          $set: { status: 'archived' as const, updatedAt: new Date() },
        },
      );
    } else {
      await this.collection.updateOne(
        { _id: learningId },
        {
          $inc: { contradictions: 1 },
          $set: { updatedAt: new Date() },
        },
      );
    }
  }

  // ── Extraction Methods ─────────────────────────────────────────────────

  extractFromRetryDelta(
    nodeName: string,
    failedOutput: any,
    succeededOutput: any,
    ctx: ExtractionContext,
    retryContext?: string,
  ): Learning | null {
    const failedStr = typeof failedOutput === 'string' ? failedOutput : JSON.stringify(failedOutput ?? {});
    const succeededStr = typeof succeededOutput === 'string' ? succeededOutput : JSON.stringify(succeededOutput ?? {});

    if (failedStr === succeededStr) return null;

    // Extract GENERALIZED pattern, not instance-specific data
    // The learning should help future executions avoid the same mistake
    let content: string;

    const failedEmpty = !failedOutput || Object.keys(failedOutput).length === 0 || failedStr === '{}';
    const succeededHasOutput = succeededOutput && Object.keys(succeededOutput).length > 0;

    if (failedEmpty && succeededHasOutput) {
      // Pattern: node produced empty output, then succeeded after clarification
      content = `In workflow "${ctx.workflowName}", the "${nodeName}" node may produce empty output when input is unclear. Use __action: "clarify" to ask for specific details instead of producing empty results.`;
    } else if (retryContext && retryContext.includes('Human provided:')) {
      // Pattern: human had to intervene — extract what was missing
      content = `In workflow "${ctx.workflowName}", the "${nodeName}" node needed human clarification to succeed. When input lacks sufficient context, use __action: "clarify" with __clarify_fields to collect the missing information upfront.`;
    } else {
      // Generic: something changed between attempts
      content = `In workflow "${ctx.workflowName}", the "${nodeName}" node failed on first attempt but succeeded on retry. Ensure input validation and use __action: "clarify" when required information is missing.`;
    }

    const now = new Date();
    return {
      content,
      type: 'mistake',
      target: 'agent' as const,
      tags: ctx.contextTags,
      scope: {
        level: ctx.contextTags.length > 0 ? 'context' : 'workflow',
        workflowName: ctx.workflowName,
        contextTags: ctx.contextTags.length > 0 ? ctx.contextTags : undefined,
      },
      source: {
        executionId: ctx.executionId,
        nodeName: ctx.nodeName,
        workflowName: ctx.workflowName,
        sourceType: 'retry_delta',
        timestamp: now,
      },
      confidence: 0.5,
      confirmations: 0,
      contradictions: 0,
      usageCount: 0,
      validFrom: now,
      tokenCount: 0,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
  }

  extractFromAutoGate(
    nodeName: string,
    action: string,
    reason: string,
    ctx: ExtractionContext,
  ): Learning | null {
    if (!reason) return null;

    const now = new Date();
    let type: LearningType;
    let content: string;

    if (action === 'stop') {
      // Generalize: WHY the workflow was stopped, not the specific reason text
      type = 'pattern';
      content = `In workflow "${ctx.workflowName}", the "${nodeName}" node stopped the execution because the task was not actionable. Before running this workflow, ensure the input is clear, specific, and contains enough context for the agent to proceed.`;
    } else if (action === 'clarify') {
      // Generalize: the node needed clarification — what pattern of input causes this?
      type = 'pattern';
      content = `In workflow "${ctx.workflowName}", the "${nodeName}" node requires clear, specific input to produce output. When input is vague or ambiguous, the agent will request clarification. Provide detailed context upfront to avoid delays.`;
    } else {
      type = 'fact';
      content = `In workflow "${ctx.workflowName}", node "${nodeName}" triggered auto-gate action "${action}".`;
    }

    return {
      content,
      type,
      target: 'agent' as const,
      tags: ctx.contextTags,
      scope: {
        level: ctx.contextTags.length > 0 ? 'context' : 'workflow',
        workflowName: ctx.workflowName,
        contextTags: ctx.contextTags.length > 0 ? ctx.contextTags : undefined,
      },
      source: {
        executionId: ctx.executionId,
        nodeName,
        workflowName: ctx.workflowName,
        sourceType: 'auto_gate',
        timestamp: now,
      },
      confidence: 0.5,
      confirmations: 0,
      contradictions: 0,
      usageCount: 0,
      validFrom: now,
      tokenCount: 0,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
  }

  extractFromHumanCorrection(
    nodeName: string,
    question: string,
    humanInput: Record<string, unknown>,
    ctx: ExtractionContext,
  ): Learning | null {
    const fieldNames = Object.keys(humanInput).filter(k => !k.startsWith('__'));
    if (fieldNames.length === 0) return null;

    // Generalize: WHAT fields were needed, not the specific values
    // "The agent needed recipient, purpose, tone" — not "the agent needed John, budget approval, formal"
    const now = new Date();
    const fieldsNeeded = fieldNames.join(', ');
    return {
      content: `In workflow "${ctx.workflowName}", the "${nodeName}" node needed additional information from the user: ${fieldsNeeded}. When building prompts for this workflow, consider requiring these fields upfront in the workflow input schema to avoid runtime clarification delays.`,
      type: 'preference',
      target: 'system' as const,  // This is a workflow design suggestion — for humans, not agents
      tags: ctx.contextTags,
      scope: {
        level: 'workflow',
        workflowName: ctx.workflowName,
      },
      source: {
        executionId: ctx.executionId,
        nodeName,
        workflowName: ctx.workflowName,
        sourceType: 'human_correction',
        timestamp: now,
      },
      confidence: 0.5,
      confirmations: 0,
      contradictions: 0,
      usageCount: 0,
      validFrom: now,
      tokenCount: 0,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
  }

  extractFromAgentOutput(
    learningsData: any[],
    ctx: ExtractionContext,
  ): Learning[] {
    if (!Array.isArray(learningsData)) return [];

    const now = new Date();
    return learningsData
      .filter(entry => entry && typeof entry.content === 'string')
      .map(entry => {
        const tags = Array.isArray(entry.tags) ? entry.tags : ctx.contextTags;
        return {
          content: entry.content,
          type: (entry.type ?? 'fact') as LearningType,
          target: (entry.target ?? 'agent') as Learning['target'],  // agent decides, defaults to agent
          tags,
          scope: {
            level: (tags.length > 0 ? 'context' : 'workflow') as Learning['scope']['level'],
            workflowName: ctx.workflowName,
            contextTags: tags.length > 0 ? tags : undefined,
          },
          source: {
            executionId: ctx.executionId,
            nodeName: ctx.nodeName,
            workflowName: ctx.workflowName,
            sourceType: 'agent_explicit' as const,
            timestamp: now,
          },
          confidence: 0.5,
          confirmations: 0,
          contradictions: 0,
          usageCount: 0,
          validFrom: now,
          tokenCount: 0,
          status: 'active' as const,
          createdAt: now,
          updatedAt: now,
        };
      });
  }

  // ── Post-Execution Review ──────────────────────────────────────────────

  async postExecutionReview(
    executionId: string,
    workflowName: string,
    contextTags: string[],
    traces: Array<{ node: string; status: string; attempt: number; durationMs: number; output: any; rawResponse?: string }>,
    hasRetries: boolean,
    hasFailures: boolean,
    hasGateEvents: boolean,
    totalDurationMs: number,
  ): Promise<void> {
    try {
      // Trigger conditions
      if (!(hasRetries || hasFailures || hasGateEvents)) return;
      if (totalDurationMs <= 30000) return;

      // Build trace summary
      const traceLines = traces.map(t => {
        let line = `- ${t.node}: ${t.status} (attempt ${t.attempt}, ${t.durationMs}ms)`;
        return line;
      }).join('\n');

      const parts: string[] = [
        `Review this workflow execution and extract reusable learnings:`,
        ``,
        `Workflow: ${workflowName}`,
        `Duration: ${totalDurationMs}ms`,
        `Context: ${contextTags.join(', ')}`,
        ``,
        `Execution trace:`,
        traceLines,
      ];

      if (hasRetries) parts.push(`\nRetries occurred — include what changed between attempts.`);
      if (hasFailures) parts.push(`\nFailures occurred — include what went wrong.`);
      if (hasGateEvents) parts.push(`\nAuto-gate triggered — include what the agent decided.`);

      parts.push(
        ``,
        `Extract 1-5 learnings as JSON array. Each learning:`,
        `{ "content": "concise, actionable statement", "type": "fact|pattern|mistake|preference|skill|optimization", "target": "agent|system", "scope": "global|workflow|context", "tags": ["tag1"] }`,
        ``,
        `target "agent": advice for the LLM agent running inside nodes — how to do its job better, avoid mistakes, follow patterns.`,
        `target "system": advice for the workflow designer or platform — workflow input schema improvements, model selection, timeout settings, retry policies.`,
        ``,
        `Only extract learnings that would be useful in FUTURE executions. Skip trivial observations.`,
        `Do NOT extract learnings from routine successful executions — only from failures, retries, clarifications, or suboptimal behavior.`,
        `Return JSON array only, no explanation.`,
      );

      const prompt = parts.join('\n');

      const { query } = await import('@anthropic-ai/claude-code');

      let rawResponse = '';
      for await (const msg of query({
        prompt,
        options: {
          model: 'sonnet',
          maxTurns: 1,
          permissionMode: 'plan',
        },
      })) {
        if (msg.type === 'assistant') {
          for (const block of (msg as any).message.content) {
            if (block.type === 'text') {
              rawResponse += block.text;
            }
          }
        }
      }

      if (!rawResponse) return;

      // Parse the JSON array from the response
      const responseText = rawResponse;
      // Find JSON array in response — may have markdown fencing
      const jsonMatch = responseText.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return;

      let learnings: any[];
      try {
        learnings = JSON.parse(jsonMatch[0]);
      } catch {
        return;
      }

      if (!Array.isArray(learnings)) return;

      const now = new Date();
      let extractedCount = 0;

      for (const entry of learnings.slice(0, 5)) {
        if (!entry || typeof entry.content !== 'string') continue;

        const scopeLevel = entry.scope === 'global' ? 'global'
          : entry.scope === 'workflow' ? 'workflow'
          : 'context';

        const tags = Array.isArray(entry.tags) ? entry.tags : contextTags;

        const learning: Learning = {
          content: entry.content,
          type: (entry.type ?? 'fact') as LearningType,
          target: (entry.target ?? 'agent') as Learning['target'],
          tags,
          scope: {
            level: scopeLevel,
            workflowName,
            contextTags: scopeLevel === 'context' && tags.length > 0 ? tags : undefined,
          },
          source: {
            executionId,
            nodeName: 'post_execution_review',
            workflowName,
            sourceType: 'post_execution_review',
            timestamp: now,
          },
          confidence: 0.5,
          confirmations: 0,
          contradictions: 0,
          usageCount: 0,
          validFrom: now,
          tokenCount: 0,
          status: 'active',
          createdAt: now,
          updatedAt: now,
        };

        await this.classifyAndStore(learning);
        extractedCount++;
      }

      if (extractedCount > 0) {
        console.log(`[learning] Post-execution review extracted ${extractedCount} learnings for execution ${executionId}`);
      }
    } catch (err) {
      // Fire-and-forget — never throw
      console.error('Post-execution review failed (non-blocking):', err);
    }
  }

  // ── Context Tag Derivation ─────────────────────────────────────────────

  deriveContextTags(
    input: Record<string, unknown>,
    workflow: WorkflowDef,
    repo?: any,
  ): string[] {
    const tags: string[] = [];

    // From repo metadata
    if (repo) {
      if (repo.path) tags.push(`repo:${repo.path}`);
      if (repo.detected?.language) {
        for (const lang of repo.detected.language) tags.push(`language:${lang}`);
      }
      if (repo.detected?.framework) {
        for (const fw of repo.detected.framework) tags.push(`framework:${fw}`);
      }
      if (Array.isArray(repo.tags)) {
        for (const t of repo.tags) tags.push(t);
      }
    }

    // From workflow
    tags.push(`workflow:${workflow.name}`);
    if (workflow.context?.requires?.includes('repo')) tags.push('type:coding');

    // From input — scan known keys
    if (input.repo_path) tags.push(`repo:${input.repo_path}`);
    if (input.platform) tags.push(`platform:${input.platform}`);
    if (input.client) tags.push(`client:${input.client}`);
    if (input.industry) tags.push(`industry:${input.industry}`);

    return [...new Set(tags)];
  }

  // ── Query & Injection ──────────────────────────────────────────────────

  async query(
    contextTags: string[],
    workflowName: string,
    roleName: string | undefined,
    nodeName: string,
    tokenBudget: number,
  ): Promise<Learning[]> {
    // Phase 1: Scope filter query
    // For context scope: learning's contextTags should be a SUBSET of execution's tags
    // i.e., every tag in the learning must exist in the execution's tags
    // MongoDB $all on the execution side won't work — query all context learnings and filter in-memory
    // ONLY inject agent-level learnings — system learnings are for humans/UI only
    const candidates = await this.collection.find({
      status: 'active',
      target: { $ne: 'system' },  // exclude system learnings from agent injection
      confidence: { $gte: 0.3 },
      $or: [
        { 'scope.level': 'global' },
        { 'scope.level': 'workflow', 'scope.workflowName': workflowName },
        ...(contextTags.length > 0
          ? [{ 'scope.level': 'context' }]
          : []),
        ...(roleName
          ? [{ 'scope.level': 'role', 'scope.roleName': roleName }]
          : []),
        { 'scope.level': 'node_pattern' },
      ],
    }).toArray();

    // Filter: context learnings must have ALL their tags present in execution's tags (subset check)
    // Filter: node_pattern candidates by regex match
    const execTagSet = new Set(contextTags);
    const filtered = candidates.filter(c => {
      if (c.scope.level === 'context') {
        const learningTags = c.scope.contextTags ?? [];
        return learningTags.length > 0 && learningTags.every(t => execTagSet.has(t));
      }
      if (c.scope.level === 'node_pattern' && c.scope.nodePattern) {
        try {
          return new RegExp(c.scope.nodePattern).test(nodeName);
        } catch {
          return false;
        }
      }
      return true;
    });

    // Phase 2: Relevance ranking (with optional embedding similarity)
    let queryEmbedding: number[] | null = null;
    try {
      const hasEmbeddedLearnings = filtered.some(l => (l as any).embedding?.length > 0);
      if (hasEmbeddedLearnings) {
        const { embed } = await import('./embedding.js');
        queryEmbedding = await embed(`${workflowName} ${nodeName} ${roleName ?? ''} ${contextTags.join(' ')}`);
      }
    } catch { /* embedding not available — skip */ }

    const now = Date.now();
    const scored = filtered.map(learning => {
      const scopeSpec = SCOPE_SPECIFICITY[learning.scope.level] ?? 0.4;
      const confidence = learning.confidence;

      const lastDate = learning.lastConfirmedAt ?? learning.createdAt;
      const daysSince = (now - lastDate.getTime()) / (1000 * 60 * 60 * 24);
      const recency = 1 / (1 + daysSince / 30);

      const novelty = 1 - Math.min(learning.usageCount / 20, 1);

      // Embedding similarity boost for chat learnings
      let semanticBoost = 0;
      if (queryEmbedding && (learning as any).embedding?.length > 0) {
        const emb = (learning as any).embedding as number[];
        let dot = 0, nA = 0, nB = 0;
        for (let i = 0; i < Math.min(emb.length, queryEmbedding.length); i++) {
          dot += emb[i] * queryEmbedding[i];
          nA += emb[i] * emb[i];
          nB += queryEmbedding[i] * queryEmbedding[i];
        }
        const denom = Math.sqrt(nA) * Math.sqrt(nB);
        semanticBoost = denom > 0 ? Math.max(0, dot / denom) : 0;
      }

      const score = semanticBoost > 0
        ? scopeSpec * 0.2 + confidence * 0.2 + recency * 0.15 + novelty * 0.15 + semanticBoost * 0.3
        : scopeSpec * 0.3 + confidence * 0.3 + recency * 0.2 + novelty * 0.2;

      return { learning, score };
    });

    scored.sort((a, b) => b.score - a.score);

    // Fit within token budget
    const selected: Learning[] = [];
    let usedTokens = 0;

    for (const { learning } of scored) {
      if (usedTokens + learning.tokenCount > tokenBudget) continue;
      selected.push(learning);
      usedTokens += learning.tokenCount;
    }

    // Fire-and-forget: update usage stats
    if (selected.length > 0) {
      const ids = selected.map(l => l._id).filter(Boolean);
      this.collection.updateMany(
        { _id: { $in: ids } },
        { $inc: { usageCount: 1 }, $set: { lastUsedAt: new Date() } },
      ).catch(() => {});
    }

    return selected;
  }

  // ── Evolution Methods ──────────────────────────────────────────────────

  async getEvolutionCandidates(
    roleName?: string,
  ): Promise<Record<string, { role: string; learnings: Learning[]; count: number }>> {
    const filter: Record<string, unknown> = {
      target: 'agent',
      confidence: { $gte: 0.8 },
      confirmations: { $gte: 3 },
      'scope.level': { $in: ['global', 'role'] },
      status: 'active',
    };

    if (roleName) {
      filter.$or = [
        { 'scope.level': 'global' },
        { 'scope.level': 'role', 'scope.roleName': roleName },
      ];
      // Remove the top-level scope.level filter since $or handles it
      delete filter['scope.level'];
    }

    const candidates = await this.collection.find(filter).limit(500).toArray();

    const result: Record<string, { role: string; learnings: Learning[]; count: number }> = {};

    for (const learning of candidates) {
      if (learning.scope.level === 'role' && learning.scope.roleName) {
        const rn = learning.scope.roleName;
        if (!result[rn]) result[rn] = { role: rn, learnings: [], count: 0 };
        result[rn].learnings.push(learning);
        result[rn].count++;
      } else if (learning.scope.level === 'global') {
        // Global learnings apply to all roles — group under '__global__'
        if (!result['__global__']) result['__global__'] = { role: '__global__', learnings: [], count: 0 };
        result['__global__'].learnings.push(learning);
        result['__global__'].count++;
      }
    }

    return result;
  }

  async previewEvolution(
    roleName: string,
    currentPrompt: string,
    learnings: Learning[],
  ): Promise<string> {
    try {
      const learningBullets = learnings
        .map(l => `- [${l.type}] ${l.content} (confidence: ${l.confidence.toFixed(2)}, ${l.confirmations} confirmations)`)
        .join('\n');

      const prompt = [
        `You are updating a role's system prompt with proven learnings from past executions.`,
        ``,
        `Current system prompt for role "${roleName}":`,
        currentPrompt,
        ``,
        `Proven learnings to integrate (high confidence, confirmed 3+ times):`,
        learningBullets,
        ``,
        `Rules:`,
        `- Merge the learnings into the system prompt naturally`,
        `- Remove any learning that's already covered by the existing prompt`,
        `- Keep the prompt concise — under 500 words total`,
        `- Preserve the original role identity and purpose`,
        `- Add a "LEARNED BEHAVIORS" section at the end for transparency`,
        `- Don't change the core instructions, just add the learned behaviors`,
        ``,
        `Return ONLY the updated system prompt text, no explanation.`,
      ].join('\n');

      const { query } = await import('@anthropic-ai/claude-code');

      let rawResponse = '';
      for await (const msg of query({
        prompt,
        options: {
          model: 'sonnet',
          maxTurns: 1,
          permissionMode: 'plan',
        },
      })) {
        if (msg.type === 'assistant') {
          for (const block of (msg as any).message.content) {
            if (block.type === 'text') {
              rawResponse += block.text;
            }
          }
        }
      }

      return rawResponse || '';
    } catch (err) {
      console.error('previewEvolution failed (non-blocking):', err);
      return '';
    }
  }

  async evolveRole(
    roleName: string,
    newPrompt: string,
    learningIds: any[],
    db: Db,
  ): Promise<{ previousPrompt: string; newPrompt: string; evolvedCount: number }> {
    const rolesCollection = db.collection('roles');

    // Get current role
    const role = await rolesCollection.findOne({ name: roleName });
    if (!role) throw new Error(`Role "${roleName}" not found`);

    const previousPrompt = role.system ?? '';

    // Save old prompt for rollback and update with new prompt
    await rolesCollection.updateOne(
      { name: roleName },
      {
        $set: {
          previousSystemPrompt: previousPrompt,
          system: newPrompt,
          updatedAt: new Date(),
        },
      },
    );

    // Mark all learnings as evolved
    const { ObjectId } = await import('mongodb');
    const objectIds = learningIds.map(id =>
      typeof id === 'string' ? new ObjectId(id) : id,
    );

    const updateResult = await this.collection.updateMany(
      { _id: { $in: objectIds } },
      {
        $set: {
          status: 'evolved' as const,
          evolvedAt: new Date(),
          evolvedIntoRole: roleName,
          updatedAt: new Date(),
        },
      },
    );

    return {
      previousPrompt,
      newPrompt,
      evolvedCount: updateResult.modifiedCount,
    };
  }

  // ── Prompt Building ────────────────────────────────────────────────────

  buildLearningsPrompt(learnings: Learning[]): string {
    if (learnings.length === 0) return '';

    const lines = learnings.map(l => {
      const scopeLabel = l.scope.level === 'global' ? 'global'
        : l.scope.level === 'workflow' ? 'workflow'
        : l.scope.level === 'context' ? 'repo'
        : l.scope.level === 'role' ? 'role'
        : 'pattern';
      return `- [${l.type}, ${scopeLabel}] ${l.content} (confidence: ${l.confidence.toFixed(1)})`;
    });

    return `\n\nLEARNINGS FROM PREVIOUS EXECUTIONS:\n${lines.join('\n')}`;
  }
}
