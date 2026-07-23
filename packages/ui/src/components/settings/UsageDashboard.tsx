import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, RefreshCw } from 'lucide-react';
import Select from '../common/Select';
import ProviderIcon, { providerIconColor } from '../common/ProviderIcon';
import TokenUsageDisplay from '../common/TokenUsageDisplay';
import {
  usage as usageApi,
  type UsageBucket,
  type UsageRangeParams,
  type UsageReport,
  type UsageSource,
} from '../../services/api';

/**
 * Settings → Usage: per-provider / per-model LLM usage with date-time
 * filtering. The report is server-cached for 1h and refreshed hourly in the
 * background; the Refresh button forces an immediate recompute. Every figure
 * is aggregated on demand from the per-LLM-run records (execution traces +
 * chat messages) — chat, workflow runs, and direct agent executions each
 * count exactly once.
 */

type PresetId = 'today' | '7d' | '30d' | 'custom';

const PRESET_LABELS: Array<{ id: PresetId; label: string }> = [
  { id: 'today', label: 'Today' },
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
  { id: 'custom', label: 'Custom' },
];

const SOURCE_LABELS: Record<UsageSource, string> = {
  chat: 'Chat',
  workflow: 'Workflows',
  agent: 'Agents',
};

const usd = (v: number): string =>
  v >= 100 ? `$${v.toFixed(0)}` : v >= 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(4)}`;

const compact = (v: number): string => {
  const fmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
  if (Math.abs(v) >= 1_000_000) return `${fmt.format(v / 1_000_000)}M`;
  if (Math.abs(v) >= 1_000) return `${fmt.format(v / 1_000)}K`;
  return fmt.format(v);
};

function agoLabel(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (mins < 1) return 'just now';
  if (mins === 1) return '1 min ago';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
}

/** datetime-local value for `Date`, in the user's local timezone. */
function toLocalInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function UsageDashboard() {
  const [preset, setPreset] = useState<PresetId>('7d');
  const [customFrom, setCustomFrom] = useState(() => toLocalInputValue(new Date(Date.now() - 7 * 24 * 3600_000)));
  const [customTo, setCustomTo] = useState(() => toLocalInputValue(new Date()));
  const [appliedCustom, setAppliedCustom] = useState<{ from: string; to: string } | null>(null);

  const [report, setReport] = useState<UsageReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [providerFilter, setProviderFilter] = useState('all');
  const [modelFilter, setModelFilter] = useState('all');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const params: UsageRangeParams | null = useMemo(() => {
    if (preset !== 'custom') return { range: preset };
    if (!appliedCustom) return null;
    return appliedCustom;
  }, [preset, appliedCustom]);

  const load = useCallback((p: UsageRangeParams) => {
    setLoading(true);
    setError(null);
    usageApi.get(p)
      .then(setReport)
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (params) load(params);
  }, [params, load]);

  const onRefresh = () => {
    if (!params || refreshing) return;
    setRefreshing(true);
    setError(null);
    usageApi.refresh(params)
      .then(setReport)
      .catch((err: Error) => setError(err.message))
      .finally(() => setRefreshing(false));
  };

  const applyCustom = () => {
    const from = new Date(customFrom);
    const to = new Date(customTo);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) {
      setError('Pick a valid range — start must be before end.');
      return;
    }
    setError(null);
    setAppliedCustom({ from: from.toISOString(), to: to.toISOString() });
  };

  const providers = useMemo(() => {
    const set = new Set((report?.byProviderModel ?? []).map((b) => b.provider));
    return ['all', ...[...set].sort()];
  }, [report]);

  const models = useMemo(() => {
    const set = new Set(
      (report?.byProviderModel ?? [])
        .filter((b) => providerFilter === 'all' || b.provider === providerFilter)
        .map((b) => b.model),
    );
    return ['all', ...[...set].sort()];
  }, [report, providerFilter]);

  const filtered = useMemo(
    () => (report?.byProviderModel ?? []).filter(
      (b) =>
        (providerFilter === 'all' || b.provider === providerFilter)
        && (modelFilter === 'all' || b.model === modelFilter),
    ),
    [report, providerFilter, modelFilter],
  );

  const filteredTotals = useMemo(
    () => filtered.reduce(
      (acc, b) => ({
        costUsd: acc.costUsd + b.costUsd,
        inputCachedTokens: acc.inputCachedTokens + b.inputCachedTokens,
        inputNonCachedTokens: acc.inputNonCachedTokens + b.inputNonCachedTokens,
        outputTokens: acc.outputTokens + b.outputTokens,
        llmCalls: acc.llmCalls + b.llmCalls,
      }),
      { costUsd: 0, inputCachedTokens: 0, inputNonCachedTokens: 0, outputTokens: 0, llmCalls: 0 },
    ),
    [filtered],
  );

  const byProvider = useMemo(() => {
    const groups = new Map<string, UsageBucket[]>();
    for (const bucket of filtered) {
      const list = groups.get(bucket.provider) ?? [];
      list.push(bucket);
      groups.set(bucket.provider, list);
    }
    return [...groups.entries()]
      .map(([provider, buckets]) => ({
        provider,
        buckets,
        costUsd: buckets.reduce((s, b) => s + b.costUsd, 0),
        llmCalls: buckets.reduce((s, b) => s + b.llmCalls, 0),
      }))
      .sort((a, b) => b.costUsd - a.costUsd);
  }, [filtered]);

  const toggleProvider = (provider: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(provider)) next.delete(provider);
      else next.add(provider);
      return next;
    });
  };

  return (
    <div className="usage-dashboard flex flex-col gap-4">
      {/* Range + refresh controls */}
      <div className="usage-range flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 rounded-[var(--radius)] border border-app bg-app-muted/40 p-0.5">
          {PRESET_LABELS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              onClick={() => setPreset(id)}
              className={`rounded-[6px] px-2.5 py-1 text-xs font-medium transition-colors ${
                preset === id
                  ? 'bg-app text-theme-primary shadow-sm border border-app'
                  : 'text-theme-muted hover:text-theme-primary'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {preset === 'custom' && (
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="datetime-local"
              value={customFrom}
              max={customTo}
              onChange={(e) => setCustomFrom(e.target.value)}
              className="settings-readonly-input !w-auto cursor-text text-xs"
              style={{ width: 'auto' }}
              aria-label="From"
            />
            <span className="text-xs text-theme-subtle">to</span>
            <input
              type="datetime-local"
              value={customTo}
              min={customFrom}
              onChange={(e) => setCustomTo(e.target.value)}
              className="settings-readonly-input !w-auto cursor-text text-xs"
              style={{ width: 'auto' }}
              aria-label="To"
            />
            <button type="button" className="btn btn-secondary text-xs" onClick={applyCustom}>
              Apply
            </button>
          </div>
        )}

        <div className="ml-auto flex items-center gap-2">
          {report && (
            <span className="text-[11px] text-theme-subtle" title={new Date(report.computedAt).toLocaleString()}>
              Updated {agoLabel(report.computedAt)}
              {report.stale ? ' · refreshing…' : ''}
            </span>
          )}
          <button
            type="button"
            className="btn btn-secondary text-xs gap-1.5"
            onClick={onRefresh}
            disabled={refreshing || !params}
            title="Recompute usage now (bypasses the hourly cache)"
          >
            <RefreshCw className={`h-3 w-3 ${refreshing ? 'animate-spin' : ''}`} />
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-[var(--radius)] border border-accent-red/30 bg-accent-red/5 px-3 py-2 text-xs text-accent-red">
          {error}
        </div>
      )}

      {/* Summary cards */}
      <div className="usage-summary grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="rounded-[var(--radius-lg)] border border-app bg-app p-4">
          <div className="text-[11px] font-medium uppercase tracking-wider text-theme-subtle">Total cost</div>
          <div className="mt-1 font-mono text-xl tabular-nums text-theme-primary">
            {loading && !report ? '…' : usd(filteredTotals.costUsd)}
          </div>
          {report && (
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-theme-muted">
              {(Object.keys(SOURCE_LABELS) as UsageSource[]).map((source) => (
                <span key={source} title={`${SOURCE_LABELS[source]}: ${usd(report.bySource[source].costUsd)}`}>
                  {SOURCE_LABELS[source]} <span className="font-mono tabular-nums">{usd(report.bySource[source].costUsd)}</span>
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="rounded-[var(--radius-lg)] border border-app bg-app p-4">
          <div className="text-[11px] font-medium uppercase tracking-wider text-theme-subtle">Tokens</div>
          <div className="mt-1.5">
            {loading && !report ? (
              <span className="font-mono text-xl text-theme-primary">…</span>
            ) : (
              <TokenUsageDisplay
                tokenUsage={{
                  inputCachedTokens: filteredTotals.inputCachedTokens,
                  inputNonCachedTokens: filteredTotals.inputNonCachedTokens,
                  outputTokens: filteredTotals.outputTokens,
                }}
              />
            )}
          </div>
        </div>
        <div className="rounded-[var(--radius-lg)] border border-app bg-app p-4">
          <div className="text-[11px] font-medium uppercase tracking-wider text-theme-subtle">LLM calls</div>
          <div className="mt-1 font-mono text-xl tabular-nums text-theme-primary">
            {loading && !report ? '…' : compact(filteredTotals.llmCalls)}
          </div>
          <div className="mt-2 text-[11px] text-theme-muted">
            Chat turns, workflow node attempts, and agent runs — each counted once.
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="usage-filters flex flex-wrap items-center gap-2">
        <Select
          value={providerFilter}
          onChange={(v) => { setProviderFilter(v); setModelFilter('all'); }}
          options={providers.map((p) => ({
            value: p,
            label: p === 'all' ? 'All providers' : p,
            icon: p === 'all'
              ? undefined
              : <ProviderIcon provider={p} className={`h-4 w-4 ${providerIconColor(p)}`} />,
          }))}
          searchable={false}
          className="w-44"
        />
        <Select
          value={modelFilter}
          onChange={setModelFilter}
          options={models.map((m) => ({
            value: m,
            label: m === 'all' ? 'All models' : m,
            icon: m === 'all' || providerFilter === 'all'
              ? undefined
              : <ProviderIcon provider={providerFilter} className={`h-4 w-4 ${providerIconColor(providerFilter)}`} />,
          }))}
          className="w-56"
        />
      </div>

      {/* Provider → model table */}
      <div className="usage-table overflow-hidden rounded-[var(--radius-lg)] border border-app">
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="border-b border-app bg-app-muted/40 text-[11px] uppercase tracking-wider text-theme-subtle">
              <th className="px-3 py-2 font-medium">Provider / model</th>
              <th className="px-3 py-2 font-medium">Source split</th>
              <th className="px-3 py-2 text-right font-medium">Calls</th>
              <th className="px-3 py-2 text-right font-medium">Tokens</th>
              <th className="px-3 py-2 text-right font-medium">Cost</th>
            </tr>
          </thead>
          <tbody>
            {loading && !report && (
              <tr><td colSpan={5} className="px-3 py-6 text-center text-theme-subtle">Computing usage…</td></tr>
            )}
            {!loading && byProvider.length === 0 && (
              <tr><td colSpan={5} className="px-3 py-6 text-center text-theme-subtle">No usage in this range.</td></tr>
            )}
            {byProvider.map((group) => {
              const open = expanded.has(group.provider);
              return [
                <tr
                  key={group.provider}
                  className="cursor-pointer border-b border-app bg-app hover:bg-app-muted/30"
                  onClick={() => toggleProvider(group.provider)}
                >
                  <td className="px-3 py-2 font-medium text-theme-primary">
                    <span className="inline-flex items-center gap-1.5">
                      {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                      {group.provider}
                      <span className="text-theme-subtle">({group.buckets.length} model{group.buckets.length === 1 ? '' : 's'})</span>
                    </span>
                  </td>
                  <td className="px-3 py-2" />
                  <td className="px-3 py-2 text-right font-mono tabular-nums text-theme-secondary">{compact(group.llmCalls)}</td>
                  <td className="px-3 py-2" />
                  <td className="px-3 py-2 text-right font-mono tabular-nums text-theme-primary">{usd(group.costUsd)}</td>
                </tr>,
                ...(open
                  ? group.buckets.map((bucket) => (
                      <tr key={`${group.provider}:${bucket.model}`} className="border-b border-app last:border-b-0">
                        <td className="px-3 py-2 pl-8 font-mono text-theme-secondary">{bucket.model}</td>
                        <td className="px-3 py-2">
                          <span className="flex flex-wrap gap-x-2.5 gap-y-0.5 text-[11px] text-theme-muted">
                            {(Object.keys(SOURCE_LABELS) as UsageSource[])
                              .filter((source) => bucket.bySource[source].llmCalls > 0)
                              .map((source) => (
                                <span key={source} title={`${SOURCE_LABELS[source]}: ${usd(bucket.bySource[source].costUsd)} · ${bucket.bySource[source].llmCalls} calls`}>
                                  {SOURCE_LABELS[source]} <span className="font-mono tabular-nums">{usd(bucket.bySource[source].costUsd)}</span>
                                </span>
                              ))}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right font-mono tabular-nums text-theme-secondary">{compact(bucket.llmCalls)}</td>
                        <td className="px-3 py-2 text-right">
                          <TokenUsageDisplay
                            tokenUsage={{
                              inputCachedTokens: bucket.inputCachedTokens,
                              inputNonCachedTokens: bucket.inputNonCachedTokens,
                              outputTokens: bucket.outputTokens,
                            }}
                          />
                        </td>
                        <td className="px-3 py-2 text-right font-mono tabular-nums text-theme-primary">{usd(bucket.costUsd)}</td>
                      </tr>
                    ))
                  : []),
              ];
            })}
          </tbody>
        </table>
      </div>

      {report && report.byProviderModel.some((b) => b.provider === 'unknown' || b.model === 'unknown') && (
        <p className="text-[11px] text-theme-subtle">
          “unknown” rows are runs recorded before model/provider attribution existed — counted once, but not attributable.
        </p>
      )}
    </div>
  );
}
