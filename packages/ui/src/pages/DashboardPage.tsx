import { useState, useEffect } from 'react';
import { dashboard } from '../services/api';
import {
  Activity, DollarSign, Clock, CheckCircle, XCircle, Loader2, Layers,
} from 'lucide-react';
import { Skeleton } from '../components/common/Skeleton';

export default function DashboardPage() {
  const [stats, setStats] = useState<any>(null);
  const [costData, setCostData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([dashboard.stats(), dashboard.cost()])
      .then(([s, c]) => { setStats(s); setCostData(c); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="p-6">
        <h1 className="text-xl font-bold text-white mb-6">Dashboard</h1>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4 mb-8">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="card p-4 space-y-3">
              <Skeleton className="w-8 h-8 rounded-lg" />
              <Skeleton className="h-8 w-1/2" />
              <Skeleton className="h-3 w-2/3" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  const byStatus = stats?.byStatus ?? {};
  const cost = stats?.cost ?? {};

  const cards = [
    {
      label: 'Total Executions',
      value: stats?.total ?? 0,
      icon: Activity,
      color: 'text-accent-blue',
      bg: 'bg-blue-500/10',
    },
    {
      label: 'Running',
      value: (byStatus.running ?? 0) + (byStatus.queued ?? 0),
      icon: Loader2,
      color: 'text-accent-blue',
      bg: 'bg-blue-500/10',
    },
    {
      label: 'Completed',
      value: byStatus.completed ?? 0,
      icon: CheckCircle,
      color: 'text-accent-green',
      bg: 'bg-green-500/10',
    },
    {
      label: 'Failed',
      value: byStatus.failed ?? 0,
      icon: XCircle,
      color: 'text-accent-red',
      bg: 'bg-red-500/10',
    },
    {
      label: 'Total Cost (est.)',
      value: `$${(cost.totalEstimated ?? 0).toFixed(2)}`,
      icon: DollarSign,
      color: 'text-accent-yellow',
      bg: 'bg-yellow-500/10',
    },
  ];

  const avgDuration = stats?.avgDurationByWorkflow ?? {};

  return (
    <div className="p-6">
      <h1 className="text-xl font-bold text-white mb-6">Dashboard</h1>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4 mb-8">
        {cards.map(card => {
          const Icon = card.icon;
          return (
            <div key={card.label} className="card p-4">
              <div className="flex items-center gap-2 mb-2">
                <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${card.bg}`}>
                  <Icon className={`w-4 h-4 ${card.color}`} />
                </div>
              </div>
              <div className="text-2xl font-bold text-white tabular-nums">{card.value}</div>
              <div className="text-xs text-gray-400 mt-0.5">{card.label}</div>
            </div>
          );
        })}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Avg duration by workflow */}
        <div className="card p-4">
          <h2 className="text-sm font-semibold text-white mb-4 flex items-center gap-2">
            <Clock className="w-4 h-4 text-gray-400" />
            Avg Duration by Workflow
          </h2>
          {Object.keys(avgDuration).length === 0 ? (
            <p className="text-xs text-gray-500">No data yet</p>
          ) : (
            <div className="space-y-3">
              {Object.entries(avgDuration).map(([name, d]: [string, any]) => (
                <div key={name} className="flex items-center justify-between">
                  <span className="text-sm text-gray-300">{name}</span>
                  <div className="text-right">
                    <span className="text-sm text-white tabular-nums">
                      {(d.avgDuration / 1000).toFixed(1)}s
                    </span>
                    <span className="text-xs text-gray-500 ml-2">
                      ({d.count} runs)
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Cost by workflow */}
        <div className="card p-4">
          <h2 className="text-sm font-semibold text-white mb-4 flex items-center gap-2">
            <Layers className="w-4 h-4 text-gray-400" />
            Cost by Workflow
          </h2>
          {!costData?.byWorkflow || Object.keys(costData.byWorkflow).length === 0 ? (
            <p className="text-xs text-gray-500">No data yet</p>
          ) : (
            <div className="space-y-3">
              {Object.entries(costData.byWorkflow).map(([name, d]: [string, any]) => (
                <div key={name} className="flex items-center justify-between">
                  <span className="text-sm text-gray-300">{name}</span>
                  <div className="text-right">
                    <span className="text-sm text-white tabular-nums">
                      ${(d.totalEstimated ?? 0).toFixed(4)}
                    </span>
                    <span className="text-xs text-gray-500 ml-2">
                      ({d.count} runs)
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
