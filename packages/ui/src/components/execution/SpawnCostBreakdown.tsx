import { Link } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import CostDisplay from '../common/CostDisplay';
import type { SpawnedChild, TokenUsageInfo } from '../../services/api';

/**
 * Per-execution cost breakdown for a spawn tree.
 *
 * Every row is internally consistent — one agent, one model, its own tokens,
 * its own registry-priced cost — so the reader can verify tokens × price at
 * every level. Aggregation happens ONLY in the footer, which is explicitly
 * labelled "all models" so the combined token count is never read against a
 * single model's rate.
 */

const COLLAPSED_ROW_LIMIT = 12;

const compactFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1, minimumFractionDigits: 0 });

function formatTokens(v: number | null | undefined): string {
  if (v == null) return '—';
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${compactFmt.format(v / 1_000_000)}M`;
  if (abs >= 1_000) return `${compactFmt.format(v / 1_000)}K`;
  return compactFmt.format(v);
}

const sumNullable = (a: number | null, b: number | null): number | null =>
  a === null && b === null ? null : (a ?? 0) + (b ?? 0);

function methodBadge(method?: string | null) {
  if (method === 'token_computed') {
    return <span title="Computed from this model's per-MTok registry prices" className="text-[9px] uppercase tracking-wider text-accent-green/70 font-label">tokens</span>;
  }
  if (method === 'sdk_reported') {
    return <span title="Provider-reported cost — no registry prices for this model" className="text-[9px] uppercase tracking-wider text-accent-yellow/70 font-label">reported</span>;
  }
  return null;
}

export default function SpawnCostBreakdown({
  ownLabel,
  ownModel,
  ownCost,
  ownTokenUsage,
  ownStatus,
  rows,
  expandAll,
  onToggleExpand,
}: {
  ownLabel: string;
  ownModel?: string | null;
  ownCost: { actual: number | null; estimated?: number; method?: string } | null;
  ownTokenUsage: TokenUsageInfo | null | undefined;
  ownStatus?: string;
  rows: SpawnedChild[];
  expandAll?: boolean;
  onToggleExpand?: (next: boolean) => void;
}) {
  if (rows.length === 0) return null;

  const baseDepth = Math.min(...rows.map((r) => r.spawnDepth ?? 1));
  const sorted = [...rows].sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime());
  const visible = expandAll ? sorted : sorted.slice(0, COLLAPSED_ROW_LIMIT);
  const hiddenCount = sorted.length - visible.length;

  // Footer totals — computed over ALL rows (own + every descendant), even
  // when the table is collapsed to the first N rows.
  let totalActual = ownCost?.actual ?? null;
  let cached = ownTokenUsage?.inputCachedTokens ?? null;
  let nonCached = ownTokenUsage?.inputNonCachedTokens ?? null;
  let output = ownTokenUsage?.outputTokens ?? null;
  let anyRunning = ownStatus === 'running' || ownStatus === 'waiting_for_input';
  for (const c of sorted) {
    if (c.cost?.actual != null) totalActual = (totalActual ?? 0) + c.cost.actual;
    if (c.tokenUsage) {
      cached = sumNullable(cached, c.tokenUsage.inputCachedTokens ?? null);
      nonCached = sumNullable(nonCached, c.tokenUsage.inputNonCachedTokens ?? null);
      output = sumNullable(output, c.tokenUsage.outputTokens ?? null);
    }
    if (c.status === 'running' || c.status === 'waiting_for_input') anyRunning = true;
  }

  const tokenCells = (usage: TokenUsageInfo | null | undefined) => (
    <>
      <td className="px-3 py-1.5 text-right tabular-nums font-mono text-theme-secondary">{formatTokens(usage?.inputNonCachedTokens)}</td>
      <td className="px-3 py-1.5 text-right tabular-nums font-mono text-theme-secondary">{formatTokens(usage?.inputCachedTokens)}</td>
      <td className="px-3 py-1.5 text-right tabular-nums font-mono text-theme-secondary">{formatTokens(usage?.outputTokens)}</td>
    </>
  );

  return (
    <section className="rounded-md border border-app bg-app-card">
      <div className="flex items-center justify-between border-b border-app px-4 py-2">
        <h3 className="text-[12px] font-medium text-theme-primary">
          Cost breakdown
          <span className="ml-2 text-theme-subtle font-normal">{rows.length} spawned agent{rows.length === 1 ? '' : 's'}</span>
        </h3>
        {anyRunning && (
          <span className="inline-flex items-center gap-1 text-[10px] text-theme-muted">
            <Loader2 className="h-3 w-3 animate-spin" /> still running — totals so far
          </span>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs font-body">
          <thead>
            <tr className="bg-app-muted overline border-b border-[rgb(var(--color-border)/0.45)]">
              <th className="text-left px-4 py-2 font-medium">Agent</th>
              <th className="text-left px-3 py-2 font-medium">Model</th>
              <th className="text-right px-3 py-2 font-medium">Input</th>
              <th className="text-right px-3 py-2 font-medium">Cache</th>
              <th className="text-right px-3 py-2 font-medium">Output</th>
              <th className="text-right px-4 py-2 font-medium">Cost</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-[rgb(var(--color-border)/0.35)]">
              <td className="px-4 py-1.5 font-mono text-theme-primary">{ownLabel} <span className="text-theme-subtle">(this run)</span></td>
              <td className="px-3 py-1.5 font-mono text-theme-secondary">{ownModel ?? '—'}</td>
              {tokenCells(ownTokenUsage)}
              <td className="px-4 py-1.5 text-right">
                <span className="inline-flex items-center gap-1.5">
                  {methodBadge(ownCost?.method)}
                  <CostDisplay cost={ownCost} />
                </span>
              </td>
            </tr>
            {visible.map((c) => {
              const indent = Math.max(0, (c.spawnDepth ?? baseDepth) - baseDepth);
              const running = c.status === 'running' || c.status === 'waiting_for_input';
              return (
                <tr key={c.id} className="border-b border-[rgb(var(--color-border)/0.35)] hover:bg-accent-blue/5">
                  <td className="px-4 py-1.5 font-mono" style={{ paddingLeft: `${16 + indent * 16}px` }}>
                    <span className="text-theme-subtle mr-1">↳</span>
                    <Link to={`/executions/${c.id}`} className="text-accent-blue hover:underline" title={c.promptPreview || c.agentName}>
                      {c.agentName}
                    </Link>
                    {running && <Loader2 className="ml-1.5 inline h-3 w-3 animate-spin text-theme-muted" />}
                    {c.status === 'failed' && <span className="ml-1.5 text-[9px] uppercase tracking-wider text-accent-red/80 font-label">failed</span>}
                  </td>
                  <td className="px-3 py-1.5 font-mono text-theme-secondary">{c.model ?? '—'}</td>
                  {tokenCells(c.tokenUsage)}
                  <td className="px-4 py-1.5 text-right">
                    <span className="inline-flex items-center gap-1.5">
                      {methodBadge(c.cost?.method)}
                      <CostDisplay cost={c.cost} />
                    </span>
                  </td>
                </tr>
              );
            })}
            {hiddenCount > 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-1.5">
                  <button type="button" onClick={() => onToggleExpand?.(true)} className="text-[11px] text-accent-blue hover:underline">
                    Show {hiddenCount} more agent{hiddenCount === 1 ? '' : 's'}
                  </button>
                </td>
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr className="bg-app-muted/40 border-t border-app">
              <td className="px-4 py-2 font-medium text-theme-primary">Total</td>
              <td className="px-3 py-2 text-theme-subtle text-[10px] uppercase tracking-wider font-label" title="Token counts combined across different models — priced per row above, not at a single rate">all models</td>
              <td className="px-3 py-2 text-right tabular-nums font-mono text-theme-primary">{formatTokens(nonCached)}</td>
              <td className="px-3 py-2 text-right tabular-nums font-mono text-theme-primary">{formatTokens(cached)}</td>
              <td className="px-3 py-2 text-right tabular-nums font-mono text-theme-primary">{formatTokens(output)}</td>
              <td className="px-4 py-2 text-right">
                <CostDisplay cost={{ actual: totalActual, estimated: 0 }} />
                {anyRunning && <span className="ml-1 text-[10px] text-theme-subtle">so far</span>}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
}
