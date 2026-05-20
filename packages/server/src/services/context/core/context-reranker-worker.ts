import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export interface RerankerWorkerConfig {
  providerId: string;
  python: string;
  script: string;
  modelName?: string;
  timeoutMs: number;
  idleTimeoutMs: number;
  queueLimit: number;
}

export interface RerankerWorkerResult {
  output: Record<string, unknown>;
  diagnostics: Array<Record<string, unknown>>;
}

interface QueuedRequest {
  requestId: string;
  payload: Record<string, unknown>;
  enqueuedAt: number;
  resolve: (result: RerankerWorkerResult) => void;
  reject: (err: Error) => void;
}

interface ActiveRequest extends QueuedRequest {
  timer: NodeJS.Timeout;
  sentAt: number;
}

const workers = new Map<string, RerankerWorker>();
let requestCounter = 0;
let shutdownHooksRegistered = false;

export async function runSharedRerankerWorker(
  config: RerankerWorkerConfig,
  payload: Record<string, unknown>,
): Promise<RerankerWorkerResult> {
  registerShutdownHooks();
  const key = workerKey(config);
  let worker = workers.get(key);
  if (!worker) {
    worker = new RerankerWorker(config);
    workers.set(key, worker);
  }
  return worker.request(payload);
}

export function shutdownContextRerankerWorkers(): void {
  for (const worker of workers.values()) {
    worker.shutdown('shutdown');
  }
  workers.clear();
}

function workerKey(config: RerankerWorkerConfig): string {
  return [
    config.python,
    config.script,
    config.providerId,
    config.modelName ?? '',
  ].join('\0');
}

function registerShutdownHooks(): void {
  if (shutdownHooksRegistered) return;
  shutdownHooksRegistered = true;
  process.once('SIGTERM', shutdownContextRerankerWorkers);
  process.once('SIGINT', shutdownContextRerankerWorkers);
  process.once('exit', shutdownContextRerankerWorkers);
}

class RerankerWorker {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuffer = '';
  private stderrTail = '';
  private queue: QueuedRequest[] = [];
  private active: ActiveRequest | null = null;
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(private config: RerankerWorkerConfig) {}

  request(payload: Record<string, unknown>): Promise<RerankerWorkerResult> {
    if (this.queue.length + (this.active ? 1 : 0) >= this.config.queueLimit) {
      return Promise.reject(new Error(`Context reranker queue is full (${this.config.queueLimit})`));
    }

    return new Promise((resolve, reject) => {
      this.queue.push({
        requestId: `rerank-${Date.now()}-${++requestCounter}`,
        payload,
        enqueuedAt: Date.now(),
        resolve,
        reject,
      });
      this.processQueue();
    });
  }

  shutdown(reason: string): void {
    this.clearIdleTimer();
    this.failActiveAndQueued(new Error(`Context reranker worker stopped: ${reason}`));
    this.stopProcess();
  }

  private processQueue(): void {
    if (this.active || this.queue.length === 0) {
      this.scheduleIdleShutdown();
      return;
    }

    const next = this.queue.shift();
    if (!next) return;

    try {
      this.clearIdleTimer();
      this.ensureProcess();
      this.send(next);
    } catch (err) {
      next.reject(err as Error);
      this.stopProcess();
      this.processQueue();
    }
  }

  private ensureProcess(): void {
    if (this.proc && !this.proc.killed) return;

    this.stdoutBuffer = '';
    this.stderrTail = '';
    this.proc = spawn(this.config.python, [this.config.script, '--worker'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ALLEN_CONTEXT_RERANKER: this.config.providerId,
        ...(this.config.modelName ? { ALLEN_CONTEXT_RERANKER_MODEL: this.config.modelName } : {}),
      },
    });

    this.proc.stdout.on('data', (chunk: Buffer) => this.handleStdout(chunk));
    this.proc.stderr.on('data', (chunk: Buffer) => {
      this.stderrTail = `${this.stderrTail}${chunk.toString()}`.slice(-4_000);
    });
    this.proc.on('error', (err) => {
      this.failActiveAndQueued(err);
      this.proc = null;
    });
    this.proc.on('close', (code, signal) => {
      const detail = this.stderrTail.trim() || `exit code=${code ?? 'unknown'} signal=${signal ?? 'none'}`;
      this.failActiveAndQueued(new Error(`Context reranker worker exited: ${detail}`));
      this.proc = null;
      this.active = null;
      this.scheduleIdleShutdown();
    });
  }

  private send(request: QueuedRequest): void {
    if (!this.proc || !this.proc.stdin.writable) {
      request.reject(new Error('Context reranker worker stdin is not writable'));
      return;
    }

    const sentAt = Date.now();
    const timer = setTimeout(() => {
      const active = this.active;
      if (!active || active.requestId !== request.requestId) return;
      this.active = null;
      active.reject(new Error('Context reranker timed out'));
      const queued = this.queue.splice(0);
      for (const queuedRequest of queued) {
        queuedRequest.reject(new Error('Context reranker worker stopped after request timeout'));
      }
      this.stopProcess();
    }, this.config.timeoutMs);

    this.active = { ...request, timer, sentAt };
    this.proc.stdin.write(`${JSON.stringify({ requestId: request.requestId, payload: request.payload })}\n`, (err) => {
      if (!err) return;
      if (this.active?.requestId === request.requestId) {
        clearTimeout(this.active.timer);
        this.active = null;
      }
      request.reject(err);
      this.stopProcess();
      this.processQueue();
    });
  }

  private handleStdout(chunk: Buffer): void {
    this.stdoutBuffer += chunk.toString();
    let newlineIndex = this.stdoutBuffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line) this.handleResponseLine(line);
      newlineIndex = this.stdoutBuffer.indexOf('\n');
    }
  }

  private handleResponseLine(line: string): void {
    const active = this.active;
    if (!active) return;

    let response: Record<string, unknown>;
    try {
      response = JSON.parse(line) as Record<string, unknown>;
    } catch (err) {
      clearTimeout(active.timer);
      this.active = null;
      active.reject(new Error(`Context reranker returned invalid worker JSON: ${(err as Error).message}`));
      this.stopProcess();
      this.processQueue();
      return;
    }

    if (response.requestId !== active.requestId) {
      return;
    }

    clearTimeout(active.timer);
    this.active = null;
    if (response.ok === false) {
      active.reject(new Error(String(response.error || 'Context reranker worker failed')));
    } else {
      const output = isRecord(response.result) ? response.result : {};
      active.resolve({
        output,
        diagnostics: [{
          code: 'semantic_reranker_worker_request_completed',
          severity: 'info',
          providerId: this.config.providerId,
          pid: this.proc?.pid,
          queueWaitMs: active.sentAt - active.enqueuedAt,
          durationMs: Date.now() - active.sentAt,
          queueDepth: this.queue.length,
          workerMode: 'persistent',
        }],
      });
    }
    this.processQueue();
  }

  private stopProcess(): void {
    const proc = this.proc;
    this.proc = null;
    this.stdoutBuffer = '';
    this.stderrTail = '';
    if (!proc || proc.killed) return;
    try {
      proc.kill('SIGTERM');
    } catch {
      // Best-effort cleanup only.
    }
  }

  private failActiveAndQueued(err: Error): void {
    if (this.active) {
      clearTimeout(this.active.timer);
      this.active.reject(err);
      this.active = null;
    }
    const queued = this.queue.splice(0);
    for (const request of queued) request.reject(err);
  }

  private scheduleIdleShutdown(): void {
    if (this.active || this.queue.length > 0 || !this.proc || this.config.idleTimeoutMs <= 0 || this.idleTimer) {
      return;
    }
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (!this.active && this.queue.length === 0) this.stopProcess();
    }, this.config.idleTimeoutMs);
  }

  private clearIdleTimer(): void {
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
