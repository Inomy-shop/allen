import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type { WebContents } from 'electron';
import { DesktopRealtimeBroker } from './realtime-broker.js';

class FakeSocket extends EventEmitter {
  readyState = WebSocket.CONNECTING;
  sent: string[] = [];
  send(payload: string) { this.sent.push(payload); }
  open() { this.readyState = WebSocket.OPEN; this.emit('open'); }
  message(payload: unknown) { this.emit('message', Buffer.from(JSON.stringify(payload))); }
  close() { this.readyState = WebSocket.CLOSED; this.emit('close'); }
}

function contents(id: number) {
  const emitter = new EventEmitter();
  return {
    id,
    send: vi.fn(),
    once: emitter.once.bind(emitter),
    isDestroyed: () => false,
  } as unknown as WebContents & { send: ReturnType<typeof vi.fn> };
}

describe('DesktopRealtimeBroker', () => {
  it('uses one socket and converges every subscribed window on the newest revision', () => {
    const sockets: FakeSocket[] = [];
    const broker = new DesktopRealtimeBroker('http://127.0.0.1:4000', () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    });
    const first = contents(1);
    const second = contents(2);

    broker.subscribe(first, ['exec-1']);
    broker.subscribe(second, ['exec-1', 'exec-2']);
    broker.setAuthToken('token');
    expect(sockets).toHaveLength(1);

    sockets[0].open();
    expect(JSON.parse(sockets[0].sent[0])).toEqual({ type: 'authenticate', token: 'token' });
    sockets[0].message({ type: 'authenticated' });
    expect(JSON.parse(sockets[0].sent.at(-1)!)).toEqual({
      type: 'subscribe',
      all: true,
      executionIds: ['exec-1', 'exec-2'],
    });

    const newest = { executionId: 'exec-1', status: 'running', revision: 4, runGeneration: 2 };
    sockets[0].message({ type: 'execution.changed', snapshot: newest });
    sockets[0].message({
      type: 'execution.changed',
      snapshot: { executionId: 'exec-1', status: 'failed', revision: 99, runGeneration: 1 },
    });

    expect(first.send).toHaveBeenCalledTimes(3); // connecting, connected, newest snapshot
    expect(second.send).toHaveBeenCalledTimes(3);
    expect(first.send).toHaveBeenLastCalledWith('allen:realtime-event', {
      type: 'execution.changed',
      snapshot: newest,
    });
    expect(broker.subscribe(first, ['exec-1'])).toEqual([newest]);
    expect(sockets).toHaveLength(1);
    broker.stop();
  });
});
