import type { Collection, Db } from 'mongodb';
import type { SystemAction } from './cron.types.js';
import { ExecutionService } from './execution.service.js';

export type MonitoringSourceType =
  | 'chat'
  | 'agent_execution'
  | 'delegation'
  | 'workflow_execution'
  | 'memory'
  | 'tool_call'
  | 'mcp'
  | 'linear_dispatch'
  | 'system';

export type MonitoringRootCauseArea =
  | 'allen_repo'
  | 'agent_prompt'
  | 'instruction_bug'
  | 'workflow_definition'
  | 'memory_system'
  | 'tool_integration'
  | 'external_dependency'
  | 'user_input'
  | 'unknown';

export type MonitoringIncidentStatus =
  | 'new'
  | 'analyzed'
  | 'ticketed'
  | 'updated_existing'
  | 'dispatched'
  | 'in_progress'
  | 'resolved'
  | 'ignored'
  | 'suppressed'
  | 'failed_to_ticket'
  | 'failed_to_dispatch';

export interface MonitoringScanArgs {
  lookbackHours?: number;
  maxCandidatesPerRun?: number;
  maxTicketsPerRun?: number;
  autoDispatch?: boolean;
  includeStatuses?: string[];
  scanSurfaces?: string[];
  stuckThresholds?: {
    chatStreamingMinutes?: number;
    agentRunningMinutes?: number;
    delegationActiveMinutes?: number;
    workflowRunningMinutes?: number;
    workflowWaitingForInputMinutes?: number;
  };
}

export interface MonitoringScanResult {
  scanned: number;
  incidents: number;
  ticketed: number;
  updated: number;
  suppressed: number;
  dispatched: number;
  failed: number;
  cursorFrom: Date;
  cursorTo: Date;
  executionId?: string;
  workflowName?: string;
}

interface MonitoringIncident {
  _id?: unknown;
  fingerprint: string;
  sourceType: MonitoringSourceType;
  severity: 'critical' | 'high' | 'medium' | 'low';
  status: MonitoringIncidentStatus;
  rootCauseArea: MonitoringRootCauseArea;
  confidence: number;
  title: string;
  summary: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
  occurrenceCount: number;
  linearIssueId?: string | null;
  linearIdentifier?: string | null;
  linearUrl?: string | null;
  routingTarget?: Record<string, unknown> | null;
  dispatchExecutionId?: string | null;
  relatedIds: Record<string, unknown>;
  evidence: Record<string, unknown>;
  redactions: string[];
  createdAt: Date;
  updatedAt: Date;
}

const DEFAULT_SCAN_ARGS: Required<Pick<
  MonitoringScanArgs,
  'lookbackHours' | 'maxCandidatesPerRun' | 'maxTicketsPerRun' | 'autoDispatch'
>> & {
  stuckThresholds: Required<NonNullable<MonitoringScanArgs['stuckThresholds']>>;
} = {
  lookbackHours: 24,
  maxCandidatesPerRun: 200,
  maxTicketsPerRun: 20,
  autoDispatch: true,
  stuckThresholds: {
    chatStreamingMinutes: 10,
    agentRunningMinutes: 45,
    delegationActiveMinutes: 45,
    workflowRunningMinutes: 90,
    workflowWaitingForInputMinutes: 1440,
  },
};

function asDate(value: unknown, fallback = new Date()): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number') {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return fallback;
}

export class MonitoringService {
  private incidents: Collection<MonitoringIncident>;
  private scanState: Collection;

  constructor(private db: Db) {
    this.incidents = db.collection<MonitoringIncident>('monitoring_incidents');
    this.scanState = db.collection('monitoring_scan_state');
  }

  async scan(args: MonitoringScanArgs = {}): Promise<MonitoringScanResult> {
    const merged = this.mergeArgs(args);
    const cursorTo = new Date();
    const cursorFrom = await this.computeCursorFrom(merged.lookbackHours);
    const execution = await this.launchAgentLedWorkflow('hourly_scan', {
      scan_window_hours: 1,
      overlap_hours: merged.lookbackHours,
      cursor_from: cursorFrom.toISOString(),
      cursor_to: cursorTo.toISOString(),
      statuses: args.includeStatuses ?? ['completed', 'failed', 'cancelled', 'canceled', 'interrupted', 'running', 'waiting_for_input'],
      scan_surfaces: args.scanSurfaces ?? [
        'chat_sessions',
        'chat_messages',
        'chat_logs',
        'agent_conversations',
        'agent_activity',
        'executions',
        'execution_logs',
        'execution_traces',
        'memory_injection_audits',
        'learnings',
        'ticket_assignments',
        'monitoring_events',
      ],
      max_records_per_surface: merged.maxCandidatesPerRun,
      maxTicketsPerRun: merged.maxTicketsPerRun,
      auto_dispatch: merged.autoDispatch,
      stuck_thresholds: merged.stuckThresholds,
    });

    return {
      scanned: 0,
      incidents: 0,
      ticketed: 0,
      updated: 0,
      suppressed: 0,
      dispatched: 0,
      failed: 0,
      cursorFrom,
      cursorTo,
      executionId: String(execution.id ?? ''),
      workflowName: String(execution.workflowName ?? 'allen-self-healing-monitor-hourly'),
    };
  }

  async handleEvent(event: Record<string, unknown>): Promise<void> {
    await this.db.collection('monitoring_events').insertOne({
      ...event,
      createdAt: new Date(),
    });
  }

  async listIncidents(opts: { limit?: number; status?: string } = {}): Promise<MonitoringIncident[]> {
    const filter: Record<string, unknown> = {};
    if (opts.status) filter.status = opts.status;
    return this.incidents
      .find(filter)
      .sort({ lastSeenAt: -1 })
      .limit(Math.min(opts.limit ?? 100, 200))
      .toArray();
  }

  async getIncident(idOrFingerprint: string): Promise<MonitoringIncident | null> {
    const { ObjectId } = await import('mongodb');
    const byFingerprint = await this.incidents.findOne({ fingerprint: idOrFingerprint });
    if (byFingerprint) return byFingerprint;
    if (!ObjectId.isValid(idOrFingerprint)) return null;
    return this.incidents.findOne({ _id: new ObjectId(idOrFingerprint) } as never);
  }

  async markIncident(idOrFingerprint: string, status: MonitoringIncidentStatus): Promise<MonitoringIncident | null> {
    const incident = await this.getIncident(idOrFingerprint);
    if (!incident) return null;
    await this.incidents.updateOne(
      { fingerprint: incident.fingerprint },
      { $set: { status, updatedAt: new Date() } },
    );
    return this.getIncident(incident.fingerprint);
  }

  async ticketIncident(idOrFingerprint: string): Promise<MonitoringIncident | null> {
    const incident = await this.getIncident(idOrFingerprint);
    if (!incident) return null;
    const started = await this.launchAgentLedWorkflow('ticket_incident', {
      targeted_incident_id: String((incident as { _id?: unknown })._id ?? incident.fingerprint),
      targeted_incident_fingerprint: incident.fingerprint,
      mode: 'ticket_incident',
    });
    await this.incidents.updateOne(
      { fingerprint: incident.fingerprint },
      { $set: { status: 'analyzed', updatedAt: new Date(), 'evidence.manualTicketWorkflowExecutionId': started.id } },
    );
    return this.getIncident(incident.fingerprint);
  }

  async dispatchIncident(idOrFingerprint: string): Promise<MonitoringIncident | null> {
    const incident = await this.getIncident(idOrFingerprint);
    if (!incident) return null;
    const started = await this.launchAgentLedWorkflow('dispatch_incident', {
      targeted_incident_id: String((incident as { _id?: unknown })._id ?? incident.fingerprint),
      targeted_incident_fingerprint: incident.fingerprint,
      mode: 'dispatch_incident',
    });
    await this.incidents.updateOne(
      { fingerprint: incident.fingerprint },
      { $set: { status: 'analyzed', updatedAt: new Date(), 'evidence.manualDispatchWorkflowExecutionId': started.id } },
    );
    return this.getIncident(incident.fingerprint);
  }

  private async launchAgentLedWorkflow(mode: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const workflow = await this.db.collection('workflows').findOne({
      $or: [
        { name: 'allen-self-healing-monitor-hourly' },
        { 'parsed.name': 'allen-self-healing-monitor-hourly' },
      ],
      archived: { $ne: true },
    });
    if (!workflow) throw new Error('Workflow "allen-self-healing-monitor-hourly" not found');
    return new ExecutionService(this.db).start(String(workflow._id), {
      mode,
      ...input,
    });
  }

  private mergeArgs(args: MonitoringScanArgs) {
    return {
      ...DEFAULT_SCAN_ARGS,
      ...args,
      stuckThresholds: {
        ...DEFAULT_SCAN_ARGS.stuckThresholds,
        ...(args.stuckThresholds ?? {}),
      },
    };
  }

  private async computeCursorFrom(lookbackHours: number): Promise<Date> {
    const fallback = new Date(Date.now() - lookbackHours * 60 * 60 * 1000);
    const state = await this.scanState.findOne({ name: 'hourly-agent' });
    const last = state?.lastSuccessfulScanAt ? asDate(state.lastSuccessfulScanAt, fallback) : fallback;
    const overlap = new Date(Date.now() - lookbackHours * 60 * 60 * 1000);
    return last < overlap ? last : overlap;
  }

}

export function createSelfHealingMonitorScanAction(db: Db): SystemAction {
  return {
    name: 'allen-self-healing-monitor-scan',
    description: 'Compatibility action that launches the agent-led Allen self-healing monitoring workflow.',
    run: async (args) => {
      const result = await new MonitoringService(db).scan((args ?? {}) as MonitoringScanArgs);
      return `launched workflow=${result.workflowName} execution=${result.executionId}`;
    },
  };
}
