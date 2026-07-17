export function normalizeExecutionStatus(status: string): string {
  return status.toLowerCase() === 'canceled' ? 'cancelled' : status;
}

export function isCancelledExecutionStatus(status?: string | null): boolean {
  const normalized = String(status ?? '').toLowerCase();
  return normalized === 'cancelled' || normalized === 'canceled';
}

export function isTerminalExecutionStatus(status?: string | null): boolean {
  const normalized = normalizeExecutionStatus(String(status ?? '').toLowerCase());
  return normalized === 'completed' || normalized === 'failed' || normalized === 'cancelled';
}
