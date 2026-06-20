/**
 * Model Registry Service
 *
 * Central registry for LLM model definitions used across the Allen app.
 * Every concrete model version is stored as its own document with fullId;
 * bare aliases (e.g. "sonnet") serve as tracking aliases that resolve to
 * a specific model version. External providers (Claude-compatible API
 * providers via claude-code) are registered here and their model suggestions
 * are sourced from this collection rather than hardcoded constants.
 *
 * PRICING SOURCES (REQ-005) — web-researched, verified 2026-06-12:
 * - Anthropic (https://www.anthropic.com/pricing; cache read = 0.1× input):
 *   - Claude Fable 5:   $10/M input, $50/M output, $1.00/M cache read
 *   - Claude Opus 4.x:  $5/M input,  $25/M output, $0.50/M cache read
 *   - Claude Sonnet 4.6: $3/M input, $15/M output, $0.30/M cache read
 *   - Claude Haiku 4.5:  $1/M input,  $5/M output, $0.10/M cache read
 * - OpenAI (https://openai.com/api/pricing/; cached input = 90% off):
 *   - GPT-5.5: $5/M input, $30/M output, $0.50/M cached input
 *   - GPT-5.4: $2.50/M input, $15/M output, $0.25/M cached input
 *   - o3: $2/M input, $8/M output; o4-mini: $1.10/M input, $4.40/M output
 *   - Codex CLI variants (gpt-5.x-codex, codex-mini): no authoritative
 *     per-variant API price published (Codex CLI typically runs on a
 *     ChatGPT subscription) → seeded null for admins to fill in
 * - DeepSeek (https://api-docs.deepseek.com/quick_start/pricing — official
 *   post-2026-05-31 prices after the 4× cut):
 *   - V4 Pro:   $0.435/M input (cache miss), $0.87/M output, $0.003625/M cache hit
 *   - V4 Flash: $0.14/M input (cache miss),  $0.28/M output, $0.0028/M cache hit
 * - Kimi/Moonshot (https://platform.moonshot.cn/docs/pricing):
 *   - K2.6: $0.95/M input, $4.00/M output, $0.16/M cached input
 *   - K2.5: $0.60/M input, $3.00/M output, $0.10/M cached input
 * - Xiaomi MiMo (https://openrouter.ai/xiaomi/mimo-v2.5-pro; Xiaomi price
 *   cut announced 2026-05-26):
 *   - MiMo V2.5 Pro: $0.435/M input, $0.87/M output, $0.0036/M cached input
 */

import type { Db } from 'mongodb';
import { ObjectId } from 'mongodb';
import { CLAUDE_COMPATIBLE_PROVIDER_CONFIGS } from './chat-providers.js';

// ── Types ──

export type ModelTier = 'default' | 'opus' | 'flash' | null;

export interface ModelRegistryEntry {
  _id: ObjectId;
  provider: string;
  fullId: string;
  displayName: string;
  providerDisplayName: string;
  costInputPerMTok?: number | null;
  costOutputPerMTok?: number | null;
  costCacheReadPerMTok?: number | null;
  tier?: ModelTier;
  isActive: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
  /** Snapshot of the seed-managed fields as last written by the boot-time
   *  seeder. A row whose current values still equal this snapshot has never
   *  been customized by an admin and is safe to refresh on the next boot. */
  seededWith?: Record<string, unknown>;
}

export type ModelRegistryInput = Omit<ModelRegistryEntry, '_id' | 'isActive' | 'createdAt' | 'updatedAt'>;

// ── Known providers (for validation) ──

const KNOWN_PROVIDERS = new Set<string>([
  'claude',
  'codex',
  ...CLAUDE_COMPATIBLE_PROVIDER_CONFIGS.map((c) => c.provider),
]);

const VALID_TIERS = new Set<string>(['default', 'opus', 'flash']);

// ── Seed Data ──

interface SeedEntry {
  provider: string;
  fullId: string;
  displayName: string;
  providerDisplayName: string;
  costInputPerMTok?: number | null;
  costOutputPerMTok?: number | null;
  costCacheReadPerMTok?: number | null;
  tier?: ModelTier;
}

const SEED_MODELS: SeedEntry[] = [
  // ── Claude (provider: 'claude') ──
  // Pricing: https://www.anthropic.com/pricing (verified 2026-06-12; cache read = 0.1× input)
  // Claude Fable 5: $10/M input, $50/M output, $1.00/M cache read
  { provider: 'claude', fullId: 'claude-fable-5', displayName: 'Fable 5', providerDisplayName: 'Claude', tier: 'default', costInputPerMTok: 10, costOutputPerMTok: 50, costCacheReadPerMTok: 1.00 },
  // Claude Sonnet 4.6: $3/M input, $15/M output, $0.30/M cache read
  { provider: 'claude', fullId: 'claude-sonnet-4-6', displayName: 'Sonnet 4.6', providerDisplayName: 'Claude', tier: 'default', costInputPerMTok: 3, costOutputPerMTok: 15, costCacheReadPerMTok: 0.30 },
  // Claude Opus 4.7: $5/M input, $25/M output, $0.50/M cache read
  { provider: 'claude', fullId: 'claude-opus-4-7', displayName: 'Opus 4.7', providerDisplayName: 'Claude', tier: 'opus', costInputPerMTok: 5, costOutputPerMTok: 25, costCacheReadPerMTok: 0.50 },
  // Claude Opus 4.8: $5/M input, $25/M output, $0.50/M cache read (preferred opus tier)
  { provider: 'claude', fullId: 'claude-opus-4-8', displayName: 'Opus 4.8', providerDisplayName: 'Claude', tier: 'opus', costInputPerMTok: 5, costOutputPerMTok: 25, costCacheReadPerMTok: 0.50 },
  // Claude Haiku 4.5: $1/M input, $5/M output, $0.10/M cache read
  { provider: 'claude', fullId: 'claude-haiku-4-5-20251001', displayName: 'Haiku 4.5', providerDisplayName: 'Claude', tier: 'flash', costInputPerMTok: 1, costOutputPerMTok: 5, costCacheReadPerMTok: 0.10 },

  // ── Codex (provider: 'codex') ──
  // Pricing: https://openai.com/api/pricing/ (verified 2026-06-12; cached input = 90% off).
  // Codex CLI variants (gpt-5.x-codex, codex-mini) have no authoritative published
  // per-MTok API price (Codex CLI typically bills via ChatGPT subscription) → null.
  // GPT-5.5: $5/M input, $30/M output, $0.50/M cached input
  { provider: 'codex', fullId: 'gpt-5.5', displayName: 'GPT-5.5', providerDisplayName: 'Codex', tier: 'default', costInputPerMTok: 5, costOutputPerMTok: 30, costCacheReadPerMTok: 0.50 },
  // GPT-5.4: $2.50/M input, $15/M output, $0.25/M cached input
  { provider: 'codex', fullId: 'gpt-5.4', displayName: 'GPT-5.4', providerDisplayName: 'Codex', costInputPerMTok: 2.50, costOutputPerMTok: 15, costCacheReadPerMTok: 0.25 },
  { provider: 'codex', fullId: 'gpt-5.3-codex', displayName: 'GPT-5.3 Codex', providerDisplayName: 'Codex' },
  { provider: 'codex', fullId: 'gpt-5.2-codex', displayName: 'GPT-5.2 Codex', providerDisplayName: 'Codex' },
  { provider: 'codex', fullId: 'gpt-5.1-codex-max', displayName: 'GPT-5.1 Codex Max', providerDisplayName: 'Codex' },
  { provider: 'codex', fullId: 'gpt-5.2', displayName: 'GPT-5.2', providerDisplayName: 'Codex' },
  { provider: 'codex', fullId: 'gpt-5.1-codex-mini', displayName: 'GPT-5.1 Codex Mini', providerDisplayName: 'Codex' },
  // o3: $2/M input, $8/M output (cached-input rate not published → null)
  { provider: 'codex', fullId: 'o3', displayName: 'o3', providerDisplayName: 'Codex', costInputPerMTok: 2, costOutputPerMTok: 8 },
  // o4-mini: $1.10/M input, $4.40/M output (cached-input rate not published → null)
  { provider: 'codex', fullId: 'o4-mini', displayName: 'o4-mini', providerDisplayName: 'Codex', costInputPerMTok: 1.10, costOutputPerMTok: 4.40 },
  { provider: 'codex', fullId: 'codex-mini', displayName: 'Codex Mini', providerDisplayName: 'Codex' },

  // ── DeepSeek (provider: 'deepseek') ──
  // Pricing: https://api-docs.deepseek.com/quick_start/pricing (verified 2026-06-12,
  // official post-2026-05-31 prices)
  // V4 Pro [1M]: $0.435/M input (cache miss), $0.87/M output, $0.003625/M cache hit
  { provider: 'deepseek', fullId: 'deepseek-v4-pro[1m]', displayName: 'DeepSeek V4 Pro [1M]', providerDisplayName: 'DeepSeek', tier: 'default', costInputPerMTok: 0.435, costOutputPerMTok: 0.87, costCacheReadPerMTok: 0.003625 },
  // V4 Flash: $0.14/M input (cache miss), $0.28/M output, $0.0028/M cache hit
  { provider: 'deepseek', fullId: 'deepseek-v4-flash', displayName: 'DeepSeek V4 Flash', providerDisplayName: 'DeepSeek', tier: 'flash', costInputPerMTok: 0.14, costOutputPerMTok: 0.28, costCacheReadPerMTok: 0.0028 },

  // ── Xiaomi MiMo (provider: 'xiaomi-mimo') ──
  // Pricing: https://openrouter.ai/xiaomi/mimo-v2.5-pro + Xiaomi 2026-05-26 price cut
  // MiMo V2.5 Pro: $0.435/M input, $0.87/M output, $0.0036/M cached input
  { provider: 'xiaomi-mimo', fullId: 'mimo-v2.5-pro', displayName: 'MiMo V2.5 Pro', providerDisplayName: 'Xiaomi MiMo', tier: 'default', costInputPerMTok: 0.435, costOutputPerMTok: 0.87, costCacheReadPerMTok: 0.0036 },

  // ── Kimi / Moonshot (provider: 'kimi') ──
  // Pricing: https://platform.moonshot.cn/docs/pricing (verified 2026-06-12)
  // K2.6: $0.95/M input, $4.00/M output, $0.16/M cached input
  { provider: 'kimi', fullId: 'kimi-k2.6', displayName: 'Kimi K2.6', providerDisplayName: 'Kimi', tier: 'opus', costInputPerMTok: 0.95, costOutputPerMTok: 4.00, costCacheReadPerMTok: 0.16 },
  // K2.5: $0.60/M input, $3.00/M output, $0.10/M cached input
  { provider: 'kimi', fullId: 'kimi-k2.5', displayName: 'Kimi K2.5', providerDisplayName: 'Kimi', tier: 'default', costInputPerMTok: 0.60, costOutputPerMTok: 3.00, costCacheReadPerMTok: 0.10 },

  // ── Z.AI / GLM (provider: 'zai') ──
  // Pricing: https://platform.zai.com/pricing (verified 2026-06-19)
  { provider: 'zai', fullId: 'glm-5.2[1m]', displayName: 'GLM-5.2 [1M]', providerDisplayName: 'GLM/Z.AI', tier: 'default', costInputPerMTok: 1.40, costOutputPerMTok: 4.40, costCacheReadPerMTok: 0.26 },
  { provider: 'zai', fullId: 'glm-5.2', displayName: 'GLM-5.2', providerDisplayName: 'GLM/Z.AI', costInputPerMTok: 1.40, costOutputPerMTok: 4.40, costCacheReadPerMTok: 0.26 },
  { provider: 'zai', fullId: 'glm-5.1', displayName: 'GLM-5.1', providerDisplayName: 'GLM/Z.AI', costInputPerMTok: 1.40, costOutputPerMTok: 4.40, costCacheReadPerMTok: 0.26 },
  { provider: 'zai', fullId: 'glm-5', displayName: 'GLM-5', providerDisplayName: 'GLM/Z.AI', costInputPerMTok: 1.00, costOutputPerMTok: 3.20, costCacheReadPerMTok: 0.20 },
  { provider: 'zai', fullId: 'glm-5-turbo', displayName: 'GLM-5 Turbo', providerDisplayName: 'GLM/Z.AI', costInputPerMTok: 1.20, costOutputPerMTok: 4.00, costCacheReadPerMTok: 0.24 },
  { provider: 'zai', fullId: 'glm-4.7', displayName: 'GLM-4.7', providerDisplayName: 'GLM/Z.AI', tier: 'flash', costInputPerMTok: 0.60, costOutputPerMTok: 2.20, costCacheReadPerMTok: 0.11 },
  { provider: 'zai', fullId: 'glm-4.7-flashx', displayName: 'GLM-4.7 FlashX', providerDisplayName: 'GLM/Z.AI', costInputPerMTok: 0.07, costOutputPerMTok: 0.40, costCacheReadPerMTok: 0.01 },
  { provider: 'zai', fullId: 'glm-4.7-flash', displayName: 'GLM-4.7 Flash', providerDisplayName: 'GLM/Z.AI', costInputPerMTok: 0.00, costOutputPerMTok: 0.00, costCacheReadPerMTok: 0.00 },
  { provider: 'zai', fullId: 'glm-4.6', displayName: 'GLM-4.6', providerDisplayName: 'GLM/Z.AI', costInputPerMTok: 0.60, costOutputPerMTok: 2.20, costCacheReadPerMTok: 0.11 },
  { provider: 'zai', fullId: 'glm-4.5', displayName: 'GLM-4.5', providerDisplayName: 'GLM/Z.AI', costInputPerMTok: 0.60, costOutputPerMTok: 2.20, costCacheReadPerMTok: 0.11 },
  { provider: 'zai', fullId: 'glm-4.5-x', displayName: 'GLM-4.5 X', providerDisplayName: 'GLM/Z.AI', costInputPerMTok: 2.20, costOutputPerMTok: 8.90, costCacheReadPerMTok: 0.45 },
  { provider: 'zai', fullId: 'glm-4.5-air', displayName: 'GLM-4.5 Air', providerDisplayName: 'GLM/Z.AI', costInputPerMTok: 0.20, costOutputPerMTok: 1.10, costCacheReadPerMTok: 0.03 },
  { provider: 'zai', fullId: 'glm-4.5-airx', displayName: 'GLM-4.5 AirX', providerDisplayName: 'GLM/Z.AI', costInputPerMTok: 1.10, costOutputPerMTok: 4.50, costCacheReadPerMTok: 0.22 },
  { provider: 'zai', fullId: 'glm-4.5-flash', displayName: 'GLM-4.5 Flash', providerDisplayName: 'GLM/Z.AI', costInputPerMTok: 0.00, costOutputPerMTok: 0.00, costCacheReadPerMTok: 0.00 },
  { provider: 'zai', fullId: 'glm-4-32b-0414-128k', displayName: 'GLM-4 32B 0414 128K', providerDisplayName: 'GLM/Z.AI', costInputPerMTok: 0.10, costOutputPerMTok: 0.10 },
];

function defaultProviderDisplayName(provider: string): string {
  return SEED_MODELS.find((model) => model.provider === provider)?.providerDisplayName
    ?? CLAUDE_COMPATIBLE_PROVIDER_CONFIGS.find((config) => config.provider === provider)?.label
    ?? provider;
}

/**
 * Static fullIds from the seed list for one provider, in seed order.
 * Use this for offline/registry-unavailable fallbacks so the seed list stays
 * the single static source of model names on the server.
 */
export function seedModelFullIdsForProvider(provider: string): string[] {
  return SEED_MODELS.filter((m) => m.provider === provider).map((m) => m.fullId);
}

// ── Legacy Alias → FullId Migration Maps ──

// Legacy alias→fullId pairs where alias ≠ fullId (4 entries).
// Used ONLY for migration write loop — identity pairs excluded to ensure
// zero writes on second boot (AC-005).
const LEGACY_ALIAS_REWRITE_MAP_IDEMPOTENT: Record<string, string> = {
  'fable': 'claude-fable-5',
  'sonnet': 'claude-sonnet-4-6',
  'opus': 'claude-opus-4-7',
  'haiku': 'claude-haiku-4-5-20251001',
};

// Combined map for READ-TIME lookups only (cost shim, engine shim, UI fallback).
// Includes identity pairs needed for resolution.
export const LEGACY_ALIAS_LOOKUP_MAP: Record<string, string> = {
  ...LEGACY_ALIAS_REWRITE_MAP_IDEMPOTENT,
  'claude-opus-4-8': 'claude-opus-4-8',
  'gpt-5.5': 'gpt-5.5', 'gpt-5.4': 'gpt-5.4',
  'gpt-5.3-codex': 'gpt-5.3-codex', 'gpt-5.2-codex': 'gpt-5.2-codex',
  'gpt-5.1-codex-max': 'gpt-5.1-codex-max', 'gpt-5.2': 'gpt-5.2',
  'gpt-5.1-codex-mini': 'gpt-5.1-codex-mini', 'o3': 'o3', 'o4-mini': 'o4-mini',
  'codex-mini': 'codex-mini',
  'deepseek-v4-pro[1m]': 'deepseek-v4-pro[1m]',
  'deepseek-v4-flash': 'deepseek-v4-flash',
  'mimo-v2.5-pro': 'mimo-v2.5-pro',
  'kimi-k2.6': 'kimi-k2.6', 'kimi-k2.5': 'kimi-k2.5',
  'glm-5.2[1m]': 'glm-5.2[1m]',
  'glm-5.2': 'glm-5.2',
  'glm-5.1': 'glm-5.1',
  'glm-5': 'glm-5',
  'glm-5-turbo': 'glm-5-turbo',
  'glm-4.7': 'glm-4.7',
  'glm-4.7-flashx': 'glm-4.7-flashx',
  'glm-4.7-flash': 'glm-4.7-flash',
  'glm-4.6': 'glm-4.6',
  'glm-4.5': 'glm-4.5',
  'glm-4.5-x': 'glm-4.5-x',
  'glm-4.5-air': 'glm-4.5-air',
  'glm-4.5-airx': 'glm-4.5-airx',
  'glm-4.5-flash': 'glm-4.5-flash',
  'glm-4-32b-0414-128k': 'glm-4-32b-0414-128k',
};

export interface MigrationCounts {
  agentsUpdated: number;
  sessionsUpdated: number;
  overridesUpdated: number;
  workflowNodesUpdated: number;
}

export async function runAliasToFullIdMigration(db: Db): Promise<MigrationCounts> {
  let agentsUpdated = 0, sessionsUpdated = 0, overridesUpdated = 0, workflowNodesUpdated = 0;
  for (const [alias, fullId] of Object.entries(LEGACY_ALIAS_REWRITE_MAP_IDEMPOTENT)) {
    const r1 = await db.collection('agents').updateMany({ model: alias }, { $set: { model: fullId } });
    agentsUpdated += r1.modifiedCount;
    const r2 = await db.collection('chat_sessions').updateMany({ model: alias }, { $set: { model: fullId } });
    sessionsUpdated += r2.modifiedCount;
    const r3 = await db.collection('chat_sessions').updateMany(
      { 'agentOverrides.model': alias }, { $set: { 'agentOverrides.model': fullId } });
    overridesUpdated += r3.modifiedCount;
    const r4 = await db.collection('workflows').updateMany(
      { 'nodes.agentOverrides.model': alias }, { $set: { 'nodes.agentOverrides.model': fullId } });
    workflowNodesUpdated += r4.modifiedCount;
  }
  console.log(`${LOG} Alias→fullId migration: ${agentsUpdated} agents, ${sessionsUpdated} sessions, ${overridesUpdated} overrides, ${workflowNodesUpdated} workflow nodes updated`);
  return { agentsUpdated, sessionsUpdated, overridesUpdated, workflowNodesUpdated };
}

// ── Legacy Provider Id Migration ──

/** The provider id 'claude-cli' was renamed to 'claude'. This map is frozen:
 *  it exists only to rewrite documents created before the rename. */
const LEGACY_PROVIDER_RENAMES: Record<string, string> = {
  'claude-cli': 'claude',
};

export interface ProviderRenameCounts {
  registryUpdated: number;
  agentsUpdated: number;
  sessionsUpdated: number;
  overridesUpdated: number;
  workflowsUpdated: number;
}

export async function runProviderRenameMigration(db: Db): Promise<ProviderRenameCounts> {
  const counts: ProviderRenameCounts = {
    registryUpdated: 0, agentsUpdated: 0, sessionsUpdated: 0, overridesUpdated: 0, workflowsUpdated: 0,
  };

  for (const [legacy, current] of Object.entries(LEGACY_PROVIDER_RENAMES)) {
    // model_registry: the unique {provider, fullId} index means a legacy doc
    // whose fullId already exists under the new provider id must be dropped
    // (the new doc wins — it is seed-managed), not renamed.
    const registry = db.collection('model_registry');
    const currentFullIds = new Set(
      (await registry.find({ provider: current }).project({ fullId: 1 }).toArray())
        .map((d) => d.fullId as string),
    );
    const legacyDocs = await registry.find({ provider: legacy }).project({ fullId: 1 }).toArray();
    for (const doc of legacyDocs) {
      if (currentFullIds.has(doc.fullId as string)) {
        await registry.deleteOne({ _id: doc._id });
      } else {
        await registry.updateOne({ _id: doc._id }, { $set: { provider: current } });
      }
      counts.registryUpdated += 1;
    }

    const r1 = await db.collection('agents').updateMany({ provider: legacy }, { $set: { provider: current } });
    counts.agentsUpdated += r1.modifiedCount;
    const r2 = await db.collection('chat_sessions').updateMany({ provider: legacy }, { $set: { provider: current } });
    counts.sessionsUpdated += r2.modifiedCount;
    const r3 = await db.collection('chat_sessions').updateMany(
      { 'agentOverrides.provider': legacy }, { $set: { 'agentOverrides.provider': current } });
    counts.overridesUpdated += r3.modifiedCount;

    // workflows store parsed.nodes as an object map (node name → node def),
    // so dotted updateMany paths can't reach agentOverrides.provider — iterate.
    const workflows = await db.collection('workflows')
      .find({}, { projection: { 'parsed.nodes': 1 } })
      .toArray();
    for (const wf of workflows) {
      const nodes = (wf as { parsed?: { nodes?: Record<string, { agentOverrides?: { provider?: string } }> } }).parsed?.nodes;
      if (!nodes || typeof nodes !== 'object') continue;
      const sets: Record<string, string> = {};
      for (const [nodeName, node] of Object.entries(nodes)) {
        if (node?.agentOverrides?.provider === legacy) {
          sets[`parsed.nodes.${nodeName}.agentOverrides.provider`] = current;
        }
      }
      if (Object.keys(sets).length > 0) {
        await db.collection('workflows').updateOne({ _id: wf._id }, { $set: sets });
        counts.workflowsUpdated += 1;
      }
    }
  }

  const total = counts.registryUpdated + counts.agentsUpdated + counts.sessionsUpdated + counts.overridesUpdated + counts.workflowsUpdated;
  if (total > 0) {
    console.log(`${LOG} Provider rename migration: ${counts.registryUpdated} registry, ${counts.agentsUpdated} agents, ${counts.sessionsUpdated} sessions, ${counts.overridesUpdated} overrides, ${counts.workflowsUpdated} workflows updated`);
  }
  return counts;
}

// ── Service ──

const LOG = '\x1b[36m[model-registry]\x1b[0m';

/** The subset of fields the boot-time seeder manages. Built with a fixed key
 *  order so two snapshots can be compared by JSON serialization. */
function seedManagedSnapshot(src: {
  displayName: string;
  providerDisplayName: string;
  fullId: string;
  tier?: ModelTier;
  costInputPerMTok?: number | null;
  costOutputPerMTok?: number | null;
  costCacheReadPerMTok?: number | null;
  isActive?: boolean;
}): Record<string, unknown> {
  return {
    displayName: src.displayName,
    providerDisplayName: src.providerDisplayName,
    fullId: src.fullId,
    tier: src.tier ?? null,
    costInputPerMTok: src.costInputPerMTok ?? null,
    costOutputPerMTok: src.costOutputPerMTok ?? null,
    costCacheReadPerMTok: src.costCacheReadPerMTok ?? null,
    isActive: src.isActive ?? true,
  };
}

function snapshotsEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  // Both sides are produced by seedManagedSnapshot (fixed key order).
  return JSON.stringify(a) === JSON.stringify(b);
}

export class ModelRegistryService {
  private db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  private get collection() {
    return this.db.collection<ModelRegistryEntry>('model_registry');
  }

  /**
   * List models with optional filters.
   * By default returns only active models sorted by provider + sortOrder.
   */
  async list(options?: { provider?: string; includeInactive?: boolean }): Promise<ModelRegistryEntry[]> {
    const filter: Record<string, unknown> = {};
    if (!options?.includeInactive) {
      filter.isActive = true;
    }
    if (options?.provider) {
      filter.provider = options.provider;
    }
    return this.collection
      .find(filter)
      .sort({ provider: 1, sortOrder: 1 })
      .toArray() as Promise<ModelRegistryEntry[]>;
  }

  /**
   * Get a single model by its MongoDB _id.
   */
  async getById(id: string): Promise<ModelRegistryEntry | null> {
    return this.collection.findOne({ _id: new ObjectId(id) }) as Promise<ModelRegistryEntry | null>;
  }

  /**
   * Create a new model registry entry.
   * Validates provider, alias, cost fields, and tier.
   * Throws on duplicate (provider, alias) with a 409-compatible message.
   */
  async create(data: ModelRegistryInput): Promise<ModelRegistryEntry> {
    this.validateInput(data);

    const now = new Date();
    const doc: ModelRegistryEntry = {
      _id: new ObjectId(),
      provider: data.provider,
      fullId: data.fullId,
      displayName: data.displayName,
      providerDisplayName: data.providerDisplayName.trim(),
      costInputPerMTok: data.costInputPerMTok ?? null,
      costOutputPerMTok: data.costOutputPerMTok ?? null,
      costCacheReadPerMTok: data.costCacheReadPerMTok ?? null,
      tier: data.tier ?? null,
      isActive: true,
      sortOrder: data.sortOrder ?? 0,
      createdAt: now,
      updatedAt: now,
    };

    try {
      await this.collection.insertOne(doc);
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'code' in err && (err as { code: number }).code === 11000) {
        throw new Error('DUPLICATE_PROVIDER_FULL_ID');
      }
      throw err;
    }

    return doc;
  }

  /**
   * Partial update. Provider and fullId are immutable.
   * Returns the updated model or null if not found.
   */
  async update(id: string, patch: Partial<ModelRegistryInput> & { isActive?: boolean }): Promise<ModelRegistryEntry | null> {
    // Prevent mutation of immutable fields
    const updates: Record<string, unknown> = {};
    if (patch.displayName !== undefined) updates.displayName = patch.displayName;
    if (patch.providerDisplayName !== undefined) updates.providerDisplayName = patch.providerDisplayName;
    if (patch.fullId !== undefined) updates.fullId = patch.fullId;
    if (patch.costInputPerMTok !== undefined) updates.costInputPerMTok = patch.costInputPerMTok ?? null;
    if (patch.costOutputPerMTok !== undefined) updates.costOutputPerMTok = patch.costOutputPerMTok ?? null;
    if (patch.costCacheReadPerMTok !== undefined) updates.costCacheReadPerMTok = patch.costCacheReadPerMTok ?? null;
    if (patch.tier !== undefined) {
      if (patch.tier !== null && !VALID_TIERS.has(patch.tier)) {
        throw new Error('INVALID_TIER');
      }
      updates.tier = patch.tier ?? null;
    }
    if (patch.sortOrder !== undefined) updates.sortOrder = patch.sortOrder;
    if (patch.isActive !== undefined) updates.isActive = patch.isActive;
    if (Object.keys(updates).length === 0) {
      return this.getById(id);
    }
    updates.updatedAt = new Date();

    const result = await this.collection.findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set: updates },
      { returnDocument: 'after' },
    );
    return result as ModelRegistryEntry | null;
  }

  /**
   * Soft-delete: sets isActive=false.
   * Returns the updated model or null if not found.
   */
  async softDelete(id: string): Promise<ModelRegistryEntry | null> {
    const result = await this.collection.findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set: { isActive: false, updatedAt: new Date() } },
      { returnDocument: 'after' },
    );
    return result as ModelRegistryEntry | null;
  }

  /**
   * Sync the seed catalog on EVERY server boot (not just on an empty
   * collection): inserts seed models that are missing and refreshes the
   * seed-managed fields (fullId, tier, per-MTok prices, isActive) of rows
   * the admin has never customized. Admin edits always win — a row whose
   * current values diverge from its `seededWith` snapshot is preserved
   * untouched, as are admin-created rows that aren't in the seed catalog.
   */
  async syncSeedModels(): Promise<{ inserted: number; refreshed: number; preserved: number }> {
    // Legacy cleanup: costPerTurn was removed in favor of per-MTok token
    // pricing — scrub it from documents written by earlier builds.
    // Idempotent and cheap (no-op when no document carries the field).
    const unset = await this.collection.updateMany(
      { costPerTurn: { $exists: true } },
      { $unset: { costPerTurn: '' } },
    );
    if (unset.modifiedCount > 0) {
      console.log(`${LOG} Removed legacy costPerTurn from ${unset.modifiedCount} models`);
    }

    const now = new Date();
    let inserted = 0;
    let refreshed = 0;
    let preserved = 0;

    // ── Legacy claude-cli → claude canonicalization ──
    // Old builds stored Claude seed models under provider 'claude-cli'.
    // This block reclaims any remaining claude-cli rows whose fullId matches
    // a Claude seed entry, renaming them to the canonical 'claude' provider
    // or — if a conflicting claude row already owns that fullId — deleting the
    // legacy duplicate.  Making this idempotent; after the first boot that runs
    // it there is nothing left to find.
    {
      const claudeSeedFullIds = new Set(
        SEED_MODELS.filter((m) => m.provider === 'claude').map((m) => m.fullId),
      );
      const allClaudeCliRows = await this.collection.find({
        provider: 'claude-cli',
      }).toArray();
      for (const row of allClaudeCliRows) {
        if (!claudeSeedFullIds.has(row.fullId)) continue;
        const conflictingRow = await this.collection.findOne({
          provider: 'claude',
          fullId: row.fullId,
        });
        if (conflictingRow) {
          // A canonical claude row already owns this fullId — drop the legacy
          // duplicate. The canonical row will be handled by the seed loop below.
          await this.collection.deleteOne({ _id: row._id });
        } else {
          // No conflict — rename to canonical provider id. The seed loop will
          // find it in the next iteration and refresh as-needed.
          await this.collection.updateOne(
            { _id: row._id },
            { $set: { provider: 'claude', updatedAt: now } },
          );
        }
      }
    }

    for (const [index, entry] of SEED_MODELS.entries()) {
      const desired = seedManagedSnapshot({ ...entry, isActive: true });
      const existing = await this.collection.findOne({ provider: entry.provider, fullId: entry.fullId });

      if (!existing) {
        await this.collection.insertOne({
          _id: new ObjectId(),
          provider: entry.provider,
          fullId: entry.fullId,
          displayName: entry.displayName,
          providerDisplayName: entry.providerDisplayName,
          costInputPerMTok: entry.costInputPerMTok ?? null,
          costOutputPerMTok: entry.costOutputPerMTok ?? null,
          costCacheReadPerMTok: entry.costCacheReadPerMTok ?? null,
          tier: entry.tier ?? null,
          isActive: true,
          sortOrder: index + 1,
          createdAt: now,
          updatedAt: now,
          seededWith: desired,
        } as ModelRegistryEntry);
        inserted++;
        continue;
      }

      const current = seedManagedSnapshot(existing);
      const snapshot = existing.seededWith;

      // Detect rows whose seed-managed display data is broken or whose
      // snapshot is missing/incomplete — these must be refreshed from the
      // current catalog rather than preserved as "admin customized".
      //
      //   - seededWith is null/undefined → pre-snapshot build
      //   - seededWith is {} (empty)      → legacy incomplete seed
      //   - seededWith is missing any of the keys seedManagedSnapshot
      //     always produces              → from an older seed version
      //   - displayName is null/blank     → broken seed data
      //   - providerDisplayName is null/blank → broken seed data
      const snapshotMissing = !snapshot
        || (typeof snapshot === 'object' && Object.keys(snapshot).length === 0);
      const snapshotIncomplete = snapshot && typeof snapshot === 'object'
        && (typeof snapshot.displayName === 'undefined'
         || typeof snapshot.providerDisplayName === 'undefined'
         || typeof snapshot.fullId === 'undefined');
      const displayNameBroken = !existing.displayName
        || typeof existing.displayName !== 'string'
        || !existing.displayName.trim();
      const providerDisplayNameBroken = !existing.providerDisplayName
        || typeof existing.providerDisplayName !== 'string'
        || !existing.providerDisplayName.trim();

      if (snapshotMissing || snapshotIncomplete || displayNameBroken || providerDisplayNameBroken) {
        // Row that needs refreshing from the current catalog.
        if (existing.isActive) {
          await this.collection.updateOne(
            { _id: existing._id },
            { $set: { ...desired, sortOrder: index + 1, seededWith: desired, updatedAt: now } },
          );
          refreshed++;
        } else {
          await this.collection.updateOne(
            { _id: existing._id },
            { $set: { seededWith: current } },
          );
          preserved++;
        }
        continue;
      }

      if (snapshotsEqual(current, snapshot)) {
        // Untouched since the last seed — safe to refresh when the catalog moved.
        if (!snapshotsEqual(current, desired)) {
          await this.collection.updateOne(
            { _id: existing._id },
            { $set: { ...desired, seededWith: desired, updatedAt: now } },
          );
          refreshed++;
        }
      } else {
        // Admin customized this row — never overwrite.
        preserved++;
      }
    }

    console.log(`${LOG} Seed sync: ${inserted} inserted, ${refreshed} refreshed, ${preserved} admin-customized preserved`);
    return { inserted, refreshed, preserved };
  }

  /**
   * Find a model by provider + fullId. Returns null if not found or inactive.
   */
  async getByFullId(provider: string, fullId: string): Promise<ModelRegistryEntry | null> {
    return this.collection.findOne({ provider, fullId, isActive: true }) as Promise<ModelRegistryEntry | null>;
  }

  /**
   * Return active models grouped by provider, used by the UI to populate
   * the model recovery dropdown. Each group has a `providerDisplayName`
   * and an array of models with `fullId`, `displayName`, and optional `tier`.
   */
  async listAvailableForRecovery(): Promise<Array<{
    provider: string;
    providerDisplayName: string;
    models: Array<{ fullId: string; displayName: string; tier?: string | null }>;
  }>> {
    const active = await this.collection
      .find({ isActive: true })
      .sort({ provider: 1, sortOrder: 1 })
      .toArray() as ModelRegistryEntry[];
    const grouped = new Map<string, { providerDisplayName: string; models: Array<{ fullId: string; displayName: string; tier?: string | null }> }>();
    for (const entry of active) {
      const provider = typeof entry.provider === 'string' ? entry.provider.trim() : '';
      if (!provider) continue;

      const providerDisplayName = typeof entry.providerDisplayName === 'string'
        ? entry.providerDisplayName.trim()
        : '';
      if (!grouped.has(provider)) {
        grouped.set(provider, { providerDisplayName, models: [] });
      }
      const group = grouped.get(provider)!;
      if (!group.providerDisplayName && providerDisplayName) {
        group.providerDisplayName = providerDisplayName;
      }
      group.models.push({
        fullId: entry.fullId,
        displayName: entry.displayName,
        tier: entry.tier,
      });
    }
    return Array.from(grouped.entries()).map(([provider, group]) => ({
      provider,
      providerDisplayName: group.providerDisplayName || defaultProviderDisplayName(provider),
      models: group.models,
    }));
  }

  // ── Validation ──

  private validateInput(data: ModelRegistryInput): void {
    if (!data.provider || !KNOWN_PROVIDERS.has(data.provider)) {
      throw new Error(`UNKNOWN_PROVIDER: ${data.provider}. Known providers: ${Array.from(KNOWN_PROVIDERS).join(', ')}`);
    }
    if (!data.displayName || typeof data.displayName !== 'string' || !data.displayName.trim()) {
      throw new Error('DISPLAY_NAME_REQUIRED');
    }
    if (!data.providerDisplayName || typeof data.providerDisplayName !== 'string' || !data.providerDisplayName.trim()) {
      throw new Error('PROVIDER_DISPLAY_NAME_REQUIRED');
    }
    if (!data.fullId || typeof data.fullId !== 'string' || !data.fullId.trim()) {
      throw new Error('FULL_ID_REQUIRED');
    }
    // Validate cost fields: must be null or non-negative
    const costFields = ['costInputPerMTok', 'costOutputPerMTok', 'costCacheReadPerMTok'] as const;
    for (const field of costFields) {
      const val = data[field];
      if (val !== null && val !== undefined && (typeof val !== 'number' || val < 0)) {
        throw new Error(`INVALID_${field.toUpperCase()}: must be null or a non-negative number`);
      }
    }
    // Validate tier
    if (data.tier !== null && data.tier !== undefined && !VALID_TIERS.has(data.tier)) {
      throw new Error(`INVALID_TIER: must be one of ${Array.from(VALID_TIERS).join(', ')} or null`);
    }
  }
}
