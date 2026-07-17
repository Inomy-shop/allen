import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

describe('desktop preload bridge', () => {
  it('exposes the realtime IPC methods used by the renderer', async () => {
    const invoke = vi.fn().mockResolvedValue([]);
    const on = vi.fn();
    const off = vi.fn();
    let exposed: Record<string, (...args: unknown[]) => unknown> | undefined;
    const source = readFileSync(new URL('../preload.cjs', import.meta.url), 'utf8');

    runInNewContext(source, {
      require: (id: string) => {
        if (id !== 'electron') throw new Error(`Unexpected module: ${id}`);
        return {
          contextBridge: {
            exposeInMainWorld: (_name: string, value: typeof exposed) => { exposed = value; },
          },
          ipcRenderer: { invoke, on, off, send: vi.fn() },
        };
      },
    });

    expect(exposed).toBeDefined();
    expect(exposed?.setRealtimeAuth).toBeTypeOf('function');
    expect(exposed?.subscribeExecutionState).toBeTypeOf('function');
    expect(exposed?.onRealtimeEvent).toBeTypeOf('function');
    expect(exposed?.onRealtimeStatus).toBeTypeOf('function');

    await exposed?.setRealtimeAuth('token');
    await exposed?.subscribeExecutionState(['execution-1']);
    expect(invoke).toHaveBeenCalledWith('allen:realtime-auth', 'token');
    expect(invoke).toHaveBeenCalledWith('allen:realtime-subscribe', ['execution-1']);
  });
});
