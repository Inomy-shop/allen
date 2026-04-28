import { useState, useEffect } from 'react';
import { dashboard } from '../services/api';
import { Activity, RefreshCw, CheckCircle2, XCircle, DollarSign, Clock, Layers } from 'lucide-react';
import { Skeleton } from '../components/common/Skeleton';

interface StatsShape {
  total: number;
  byStatus: Record<string, number>;
  cost: { totalEstimated: number; totalActual: number };
  avgDurationByWorkflow: Record<string, { avgDuration: number; count: number }>;
}
interface CostShape {
  byWorkflow: Record<string, { totalEstimated: number; totalActual: number; count: number }>;
}

export default function DashboardPage() {
  const [stats, setStats] = useState<StatsShape | null>(null);
  const [costData, setCostData] = useState<CostShape | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([dashboard.stats(), dashboard.cost()])
      .then(([s, c]) => { setStats(s); setCostData(c); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const byStatus = stats?.byStatus ?? {};
  const cost = stats?.cost ?? { totalEstimated: 0, totalActual: 0 };

  const cards = [
    {
      label: 'Total executions',
      value: stats?.total ?? 0,
      icon: Activity,
      tint: 'bg-app-muted text-theme-secondary',
    },
    {
      label: 'Running',
      value: (byStatus.running ?? 0) + (byStatus.queued ?? 0),
      icon: RefreshCw,
      tint: 'bg-accent-soft text-accent',
    },
    {
      label: 'Completed',
      value: byStatus.completed ?? 0,
      icon: CheckCircle2,
      tint: 'bg-accent-green/10 text-accent-green',
    },
    {
      label: 'Failed',
      value: byStatus.failed ?? 0,
      icon: XCircle,
      tint: 'bg-accent-red/10 text-accent-red',
    },
    {
      label: 'Total cost (est.)',
      value: `$${(cost.totalEstimated ?? 0).toFixed(2)}`,
      icon: DollarSign,
      tint: 'bg-accent-yellow/10 text-accent-yellow',
    },
  ];

  const avgDuration = stats?.avgDurationByWorkflow ?? {};
  const avgDurationEntries = Object.entries(avgDuration)
    .sort(([, a], [, b]) => (b.avgDuration ?? 0) - (a.avgDuration ?? 0));

  const byWorkflow = costData?.byWorkflow ?? {};
  const costEntries = Object.entries(byWorkflow)
    .sort(([, a], [, b]) => (b.totalEstimated ?? 0) - (a.totalEstimated ?? 0));
  const maxCost = Math.max(1, ...costEntries.map(([, d]) => d.totalEstimated ?? 0));

  return (
    <div className="px-6 pt-5 pb-8">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 mb-2 text-[12px] text-theme-muted">
        <span>Inomy</span>
        <span className="text-theme-subtle">/</span>
        <span>Overview</span>
      </div>

      {/* Title row */}
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-[20px] font-semibold text-theme-primary tracking-tight">Overview</h1>
        <div className="flex items-center gap-2">
          <button className="btn btn-secondary btn-sm" type="button">
            <Clock className="w-3.5 h-3.5" />
            Last 24 hours
          </button>
        </div>
      </div>

      {/* Tabs (visual only — match the reference) */}
      <div className="flex items-center gap-1 mb-5 border-b border-app">
        <div className="px-2.5 py-1.5 text-[13px] font-medium text-theme-primary border-b-2 border-accent -mb-px">Overview</div>
        <div className="px-2.5 py-1.5 text-[13px] text-theme-muted">Workflows</div>
        <div className="px-2.5 py-1.5 text-[13px] text-theme-muted">Agents</div>
        <div className="px-2.5 py-1.5 text-[13px] text-theme-muted">Cost</div>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3 mb-5">
        {loading
          ? Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="card p-4 space-y-3">
                <Skeleton className="w-7 h-7 rounded" />
                <Skeleton className="h-7 w-1/2" />
                <Skeleton className="h-3 w-2/3" />
              </div>
            ))
          : cards.map(card => {
              const Icon = card.icon;
              return (
                <div key={card.label} className="card p-4">
                  <div className={`w-7 h-7 rounded-md flex items-center justify-center mb-3 ${card.tint}`}>
                    <Icon className="w-3.5 h-3.5" />
                  </div>
                  <div className="text-[24px] font-semibold text-theme-primary tabular-nums leading-none tracking-tight">
                    {card.value}
                  </div>
                  <div className="overline mt-2">{card.label}</div>
                </div>
              );
            })}
      </div>

      {/* 2-up panels */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Avg duration */}
        <div className="card overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-3 border-b border-app">
            <Clock className="w-3.5 h-3.5 text-theme-muted" />
            <span className="overline">Avg duration by workflow</span>
          </div>
          {loading ? (
            <div className="p-4 space-y-2">
              {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-4 w-full" />)}
            </div>
          ) : avgDurationEntries.length === 0 ? (
            <div className="px-4 py-8 text-center text-[12px] text-theme-subtle">No data yet</div>
          ) : (
            <div className="divide-y divide-border">
              {avgDurationEntries.map(([name, d]) => (
                <div key={name} className="flex items-center px-4 py-2 text-[12px] font-mono">
                  <span className="flex-1 min-w-0 truncate text-theme-secondary">{name}</span>
                  <span className="ml-3 text-theme-primary tabular-nums">{(d.avgDuration / 1000).toFixed(1)}s</span>
                  <span className="ml-3 w-16 text-right text-theme-subtle tabular-nums">({d.count} runs)</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Cost by workflow — rank tile + progress bar */}
        <div className="card overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-3 border-b border-app">
            <Layers className="w-3.5 h-3.5 text-theme-muted" />
            <span className="overline">Cost by workflow</span>
          </div>
          {loading ? (
            <div className="p-4 space-y-2">
              {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-6 w-full" />)}
            </div>
          ) : costEntries.length === 0 ? (
            <div className="px-4 py-8 text-center text-[12px] text-theme-subtle">No data yet</div>
          ) : (
            <div className="divide-y divide-border">
              {costEntries.map(([name, d], i) => {
                const totalEst = d.totalEstimated ?? 0;
                return (
                  <div key={name} className="flex items-center gap-3 px-4 py-2.5">
                    <div className="w-6 h-6 rounded-md bg-accent-soft text-accent flex items-center justify-center text-[11px] font-mono font-semibold shrink-0">
                      {i + 1}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-[12px] font-mono font-medium text-theme-primary truncate">{name}</div>
                      <div className="h-[3px] mt-1.5 bg-app-muted rounded-full overflow-hidden">
                        <div
                          className="h-full bg-accent rounded-full"
                          style={{ width: `${(totalEst / maxCost) * 100}%` }}
                        />
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-[13px] font-mono font-medium tabular-nums text-theme-primary">${totalEst.toFixed(2)}</div>
                      <div className="text-[10px] text-theme-subtle font-mono">{d.count} runs</div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
