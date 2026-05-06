import { createHash } from 'node:crypto';
import type { Db, Document } from 'mongodb';
import { ObjectId } from 'mongodb';
import type { ChatTool } from './chat-tools.js';

const MAX_LIMIT = 100;

const SURFACES: Record<string, {
  collection: string;
  dateFields: string[];
  statusField?: string;
  defaultSort: Record<string, 1 | -1>;
  rootFields: string[];
}> = {
  chat_sessions: {
    collection: 'chat_sessions',
    dateFields: ['createdAt', 'updatedAt'],
    statusField: 'status',
    defaultSort: { updatedAt: -1, createdAt: -1 },
    rootFields: ['_id', 'id', 'sessionId'],
  },
  chat_messages: {
    collection: 'chat_messages',
    dateFields: ['createdAt', 'updatedAt', 'completedAt'],
    statusField: 'status',
    defaultSort: { createdAt: -1 },
    rootFields: ['_id', 'id', 'sessionId', 'messageId'],
  },
  chat_logs: {
    collection: 'chat_logs',
    dateFields: ['timestamp', 'createdAt'],
    statusField: 'status',
    defaultSort: { timestamp: -1, createdAt: -1 },
    rootFields: ['_id', 'id', 'sessionId', 'messageId', 'llmSessionId'],
  },
  agent_conversations: {
    collection: 'agent_conversations',
    dateFields: ['createdAt', 'updatedAt', 'completedAt'],
    statusField: 'status',
    defaultSort: { updatedAt: -1, createdAt: -1 },
    rootFields: ['_id', 'id', 'chatSessionId', 'parentConversationId'],
  },
  agent_activity: {
    collection: 'agent_activity',
    dateFields: ['at', 'createdAt'],
    defaultSort: { at: -1, createdAt: -1 },
    rootFields: ['_id', 'id', 'refId', 'executionId', 'conversationId'],
  },
  executions: {
    collection: 'executions',
    dateFields: ['startedAt', 'updatedAt', 'completedAt'],
    statusField: 'status',
    defaultSort: { startedAt: -1 },
    rootFields: ['_id', 'id', 'rootExecutionId', 'parentExecutionId', 'workflowName'],
  },
  execution_logs: {
    collection: 'execution_logs',
    dateFields: ['timestamp', 'createdAt'],
    statusField: 'level',
    defaultSort: { timestamp: -1, createdAt: -1 },
    rootFields: ['_id', 'id', 'executionId', 'node'],
  },
  execution_traces: {
    collection: 'execution_traces',
    dateFields: ['startedAt', 'completedAt', 'createdAt'],
    statusField: 'status',
    defaultSort: { completedAt: -1, startedAt: -1 },
    rootFields: ['_id', 'id', 'executionId', 'node', 'agent'],
  },
  memory_injection_audits: {
    collection: 'memory_injection_audits',
    dateFields: ['createdAt'],
    defaultSort: { createdAt: -1 },
    rootFields: ['_id', 'id', 'rootId', 'rootType', 'agentName'],
  },
  learnings: {
    collection: 'learnings',
    dateFields: ['createdAt', 'updatedAt'],
    statusField: 'status',
    defaultSort: { updatedAt: -1, createdAt: -1 },
    rootFields: ['_id', 'id', 'source.executionId', 'source.workflowName', 'source.nodeName'],
  },
  ticket_assignments: {
    collection: 'ticket_assignments',
    dateFields: ['assignedAt', 'updatedAt'],
    statusField: 'status',
    defaultSort: { updatedAt: -1, assignedAt: -1 },
    rootFields: ['_id', 'id', 'linearIssueId', 'executionId', 'workspaceId'],
  },
  monitoring_events: {
    collection: 'monitoring_events',
    dateFields: ['createdAt'],
    defaultSort: { createdAt: -1 },
    rootFields: ['_id', 'id', 'sourceId', 'sourceType'],
  },
  monitoring_incidents: {
    collection: 'monitoring_incidents',
    dateFields: ['createdAt', 'updatedAt', 'firstSeenAt', 'lastSeenAt'],
    statusField: 'status',
    defaultSort: { updatedAt: -1, lastSeenAt: -1 },
    rootFields: ['_id', 'fingerprint', 'linearIssueId', 'dispatchExecutionId'],
  },
};

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]'],
  [/(api[_-]?key|token|secret|password|authorization)(["'\s:=]+)([^"',\s}]+)/gi, '$1$2[REDACTED]'],
  [/(sk-[A-Za-z0-9]{20,})/g, '[REDACTED_OPENAI_KEY]'],
  [/(ghp_[A-Za-z0-9]{20,})/g, '[REDACTED_GITHUB_TOKEN]'],
];

function toDate(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number') {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}

function limitArg(value: unknown, fallback = 25): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(1, Math.min(n, MAX_LIMIT)) : fallback;
}

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[MAX_DEPTH]';
  if (typeof value === 'string') {
    let out = value;
    for (const [pattern, replacement] of SECRET_PATTERNS) {
      out = out.replace(pattern, replacement);
      pattern.lastIndex = 0;
    }
    return out.length > 4000 ? `${out.slice(0, 4000)}... [truncated]` : out;
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redact(item, depth + 1));
  if (value instanceof Date) return value.toISOString();
  if (value instanceof ObjectId) return value.toString();
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>).slice(0, 120)) {
      if (/token|secret|password|authorization|cookie|api[_-]?key/i.test(key)) {
        out[key] = '[REDACTED]';
      } else {
        out[key] = redact(val, depth + 1);
      }
    }
    return out;
  }
  return value;
}

function serializeDoc(doc: Document): Record<string, unknown> {
  return redact({ ...doc, _id: doc._id ? String(doc._id) : undefined }) as Record<string, unknown>;
}

function maybeObjectId(value: string): string | ObjectId {
  return ObjectId.isValid(value) ? new ObjectId(value) : value;
}

function hashIncident(input: Record<string, unknown>): string {
  const key = JSON.stringify({
    title: input.title,
    sourceType: input.source_type,
    rootCauseArea: input.root_cause_area,
    relatedIds: input.related_ids,
    summary: String(input.summary ?? '').slice(0, 500),
  });
  return createHash('sha256').update(key).digest('hex').slice(0, 32);
}

function dateFilter(surface: (typeof SURFACES)[string], since?: Date | null, until?: Date | null): Record<string, unknown> | null {
  if (!since && !until) return null;
  const range: Record<string, Date> = {};
  if (since) range.$gte = since;
  if (until) range.$lte = until;
  return { $or: surface.dateFields.map((field) => ({ [field]: range })) };
}

function rootFilter(surface: (typeof SURFACES)[string], rootId: string): Record<string, unknown> {
  const values = [rootId, maybeObjectId(rootId)];
  return {
    $or: surface.rootFields.flatMap((field) => values.map((value) => ({ [field]: value }))),
  };
}

function textFilter(text: string): Record<string, unknown> {
  const rx = { $regex: text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
  return {
    $or: [
      { title: rx },
      { summary: rx },
      { error: rx },
      { errorMessage: rx },
      { message: rx },
      { content: rx },
      { rawResponse: rx },
      { renderedPrompt: rx },
      { userMessage: rx },
      { assistantResponse: rx },
    ],
  };
}

function combine(filters: Array<Record<string, unknown> | null | undefined>): Record<string, unknown> {
  const clean = filters.filter(Boolean) as Record<string, unknown>[];
  if (clean.length === 0) return {};
  if (clean.length === 1) return clean[0];
  return { $and: clean };
}

const getScanCursor: ChatTool = {
  name: 'allen_monitoring_get_scan_cursor',
  description: 'Read the self-healing monitoring scan cursor. Agent uses this to plan the hourly scan window.',
  inputSchema: {
    type: 'object',
    properties: { name: { type: 'string', description: 'Cursor name. Default: hourly-agent.' } },
  },
  async execute(args, db) {
    const name = String(args.name ?? 'hourly-agent');
    const cursor = await db.collection('monitoring_scan_state').findOne({ name });
    return { cursor: cursor ? serializeDoc(cursor) : null };
  },
};

const updateScanCursor: ChatTool = {
  name: 'allen_monitoring_update_scan_cursor',
  description: 'Update the self-healing monitoring scan cursor after the agent-led scan has completed.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      last_successful_scan_at: { type: 'string', description: 'ISO timestamp.' },
      execution_id: { type: 'string' },
      summary: { type: 'string' },
    },
  },
  destructive: true,
  async execute(args, db, context) {
    const name = String(args.name ?? 'hourly-agent');
    const lastSuccessfulScanAt = toDate(args.last_successful_scan_at) ?? new Date();
    await db.collection('monitoring_scan_state').updateOne(
      { name },
      {
        $set: {
          name,
          lastSuccessfulScanAt,
          updatedAt: new Date(),
          updatedByAgent: context?.parentExecutionId ?? context?.rootExecutionId ?? 'agent',
          executionId: args.execution_id,
          summary: args.summary,
        },
      },
      { upsert: true },
    );
    return { ok: true, name, last_successful_scan_at: lastSuccessfulScanAt.toISOString() };
  },
};

const searchRecords: ChatTool = {
  name: 'allen_monitoring_search_records',
  description: 'Search Allen runtime records for agent-led self-healing evidence collection. Returns redacted raw records; the agent decides what is wrong.',
  inputSchema: {
    type: 'object',
    properties: {
      surface: { type: 'string', description: `One of: ${Object.keys(SURFACES).join(', ')}` },
      since: { type: 'string', description: 'ISO timestamp lower bound.' },
      until: { type: 'string', description: 'ISO timestamp upper bound.' },
      statuses: { type: 'array', items: { type: 'string' } },
      root_id: { type: 'string', description: 'Execution id, chat session id, incident fingerprint, or other related id.' },
      text: { type: 'string', description: 'Case-insensitive text search across common fields.' },
      limit: { type: 'number' },
    },
    required: ['surface'],
  },
  async execute(args, db) {
    const surfaceName = String(args.surface ?? '');
    const surface = SURFACES[surfaceName];
    if (!surface) return { error: `Unknown surface "${surfaceName}". Allowed: ${Object.keys(SURFACES).join(', ')}` };

    const statuses = Array.isArray(args.statuses) ? args.statuses.map(String).filter(Boolean) : [];
    const filters: Array<Record<string, unknown> | null> = [
      dateFilter(surface, toDate(args.since), toDate(args.until)),
      statuses.length > 0 && surface.statusField ? { [surface.statusField]: { $in: statuses } } : null,
      typeof args.root_id === 'string' && args.root_id ? rootFilter(surface, args.root_id) : null,
      typeof args.text === 'string' && args.text ? textFilter(args.text) : null,
    ];

    const docs = await db.collection(surface.collection)
      .find(combine(filters))
      .sort(surface.defaultSort)
      .limit(limitArg(args.limit))
      .toArray();

    return {
      surface: surfaceName,
      collection: surface.collection,
      count: docs.length,
      records: docs.map(serializeDoc),
    };
  },
};

const getRecord: ChatTool = {
  name: 'allen_monitoring_get_record',
  description: 'Fetch one full redacted runtime record by surface and id.',
  inputSchema: {
    type: 'object',
    properties: {
      surface: { type: 'string', description: `One of: ${Object.keys(SURFACES).join(', ')}` },
      id: { type: 'string', description: 'Mongo _id or logical id.' },
    },
    required: ['surface', 'id'],
  },
  async execute(args, db) {
    const surfaceName = String(args.surface ?? '');
    const surface = SURFACES[surfaceName];
    if (!surface) return { error: `Unknown surface "${surfaceName}".` };
    const id = String(args.id ?? '');
    if (!id) return { error: 'id is required' };
    const doc = await db.collection(surface.collection).findOne({
      $or: [{ _id: maybeObjectId(id) }, { id }, { fingerprint: id }],
    } as Document);
    return doc ? { record: serializeDoc(doc) } : { error: `No ${surfaceName} record found for ${id}` };
  },
};

const createEvidenceBundle: ChatTool = {
  name: 'allen_monitoring_create_evidence_bundle',
  description: 'Persist an agent-curated evidence bundle after reviewing raw Allen runtime records.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      summary: { type: 'string' },
      record_refs: { type: 'array', items: { type: 'object' } },
      evidence: { type: 'object' },
      scan_window: { type: 'object' },
    },
    required: ['title', 'summary'],
  },
  destructive: true,
  async execute(args, db, context) {
    const now = new Date();
    const result = await db.collection('monitoring_evidence_bundles').insertOne({
      title: args.title,
      summary: args.summary,
      recordRefs: args.record_refs ?? [],
      evidence: redact(args.evidence ?? {}),
      scanWindow: args.scan_window ?? {},
      createdByExecutionId: context?.parentExecutionId ?? context?.rootExecutionId ?? null,
      createdAt: now,
      updatedAt: now,
    });
    return { evidence_bundle_id: result.insertedId.toString() };
  },
};

const searchIncidents: ChatTool = {
  name: 'allen_monitoring_search_incidents',
  description: 'Search previously recorded self-healing monitoring incidents for dedupe and follow-up decisions.',
  inputSchema: {
    type: 'object',
    properties: {
      status: { type: 'string' },
      root_cause_area: { type: 'string' },
      source_type: { type: 'string' },
      text: { type: 'string' },
      linear_issue_id: { type: 'string' },
      limit: { type: 'number' },
    },
  },
  async execute(args, db) {
    const filters: Record<string, unknown>[] = [];
    if (args.status) filters.push({ status: String(args.status) });
    if (args.root_cause_area) filters.push({ rootCauseArea: String(args.root_cause_area) });
    if (args.source_type) filters.push({ sourceType: String(args.source_type) });
    if (args.linear_issue_id) filters.push({ linearIssueId: String(args.linear_issue_id) });
    if (args.text) filters.push(textFilter(String(args.text)));
    const docs = await db.collection('monitoring_incidents')
      .find(combine(filters))
      .sort({ updatedAt: -1, lastSeenAt: -1 })
      .limit(limitArg(args.limit, 20))
      .toArray();
    return { count: docs.length, incidents: docs.map(serializeDoc) };
  },
};

const upsertIncident: ChatTool = {
  name: 'allen_monitoring_upsert_incident',
  description: 'Create or update a monitoring incident from the agent decision. This stores the agent analysis; it does not create Linear tickets.',
  inputSchema: {
    type: 'object',
    properties: {
      fingerprint: { type: 'string' },
      title: { type: 'string' },
      summary: { type: 'string' },
      source_type: { type: 'string' },
      root_cause_area: { type: 'string' },
      severity: { type: 'string' },
      confidence: { type: 'number' },
      status: { type: 'string' },
      related_ids: { type: 'object' },
      evidence: { type: 'object' },
      evidence_bundle_id: { type: 'string' },
      agent_decision: { type: 'object' },
    },
    required: ['title', 'summary', 'source_type', 'root_cause_area', 'severity', 'confidence'],
  },
  destructive: true,
  async execute(args, db, context) {
    const now = new Date();
    const fingerprint = String(args.fingerprint ?? hashIncident(args));
    await db.collection('monitoring_incidents').updateOne(
      { fingerprint },
      {
        $setOnInsert: {
          fingerprint,
          firstSeenAt: now,
          createdAt: now,
          occurrenceCount: 0,
        },
        $set: {
          title: args.title,
          summary: args.summary,
          sourceType: args.source_type,
          rootCauseArea: args.root_cause_area,
          severity: args.severity,
          confidence: args.confidence,
          status: args.status ?? 'analyzed',
          relatedIds: args.related_ids ?? {},
          evidence: redact(args.evidence ?? {}),
          evidenceBundleId: args.evidence_bundle_id ?? null,
          agentDecision: redact(args.agent_decision ?? {}),
          decidedByExecutionId: context?.parentExecutionId ?? context?.rootExecutionId ?? null,
          lastSeenAt: now,
          updatedAt: now,
        },
        $inc: { occurrenceCount: 1 },
      },
      { upsert: true },
    );
    const incident = await db.collection('monitoring_incidents').findOne({ fingerprint });
    return { incident: incident ? serializeDoc(incident) : null };
  },
};

const updateIncident: ChatTool = {
  name: 'allen_monitoring_update_incident',
  description: 'Update a monitoring incident after Linear ticketing, routing, bug-fix dispatch, suppression, or resolution.',
  inputSchema: {
    type: 'object',
    properties: {
      incident_id: { type: 'string', description: 'Mongo _id or fingerprint.' },
      status: { type: 'string' },
      linear_issue_id: { type: 'string' },
      linear_identifier: { type: 'string' },
      linear_url: { type: 'string' },
      routing_target: { type: 'object' },
      dispatch_execution_id: { type: 'string' },
      agent_decision: { type: 'object' },
      evidence_patch: { type: 'object' },
    },
    required: ['incident_id'],
  },
  destructive: true,
  async execute(args, db, context) {
    const id = String(args.incident_id ?? '');
    if (!id) return { error: 'incident_id is required' };
    const filter = ObjectId.isValid(id)
      ? { $or: [{ _id: new ObjectId(id) }, { fingerprint: id }] }
      : { fingerprint: id };
    const set: Record<string, unknown> = { updatedAt: new Date(), updatedByExecutionId: context?.parentExecutionId ?? context?.rootExecutionId ?? null };
    if (args.status) set.status = args.status;
    if (args.linear_issue_id !== undefined) set.linearIssueId = args.linear_issue_id;
    if (args.linear_identifier !== undefined) set.linearIdentifier = args.linear_identifier;
    if (args.linear_url !== undefined) set.linearUrl = args.linear_url;
    if (args.routing_target !== undefined) set.routingTarget = redact(args.routing_target);
    if (args.dispatch_execution_id !== undefined) set.dispatchExecutionId = args.dispatch_execution_id;
    if (args.agent_decision !== undefined) set.agentDecision = redact(args.agent_decision);
    if (args.evidence_patch !== undefined) {
      for (const [key, value] of Object.entries(redact(args.evidence_patch) as Record<string, unknown>)) {
        set[`evidence.${key}`] = value;
      }
    }
    await db.collection('monitoring_incidents').updateOne(filter, { $set: set });
    const incident = await db.collection('monitoring_incidents').findOne(filter);
    return { incident: incident ? serializeDoc(incident) : null };
  },
};

const resolveRepoPath: ChatTool = {
  name: 'allen_monitoring_resolve_repo_path',
  description: 'Resolve the Allen repo path to pass into bug-investigate-and-fix for self-healing incidents.',
  inputSchema: { type: 'object', properties: {} },
  async execute(_args, db) {
    if (process.env.ALLEN_SELF_HEALING_REPO_PATH) {
      return { repo_path: process.env.ALLEN_SELF_HEALING_REPO_PATH, source: 'env' };
    }
    const repo = await db.collection('repos').findOne({
      status: 'active',
      $or: [
        { name: { $regex: '^allen$', $options: 'i' } },
        { path: { $regex: '/allen$' } },
      ],
    });
    return repo?.path
      ? { repo_path: String(repo.path), source: 'repos', repo: serializeDoc(repo) }
      : { repo_path: null, error: 'Allen repo path not found. Set ALLEN_SELF_HEALING_REPO_PATH or register the Allen repo.' };
  },
};

export const monitoringAgentTools: ChatTool[] = [
  getScanCursor,
  updateScanCursor,
  searchRecords,
  getRecord,
  createEvidenceBundle,
  searchIncidents,
  upsertIncident,
  updateIncident,
  resolveRepoPath,
];
