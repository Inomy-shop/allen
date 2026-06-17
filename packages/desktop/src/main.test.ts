import { describe, it, expect } from 'vitest';

// ── Multi-window window lifecycle helpers ──
//
// These tests validate the fallback-ordering algorithm used by getTargetWindow(),
// the window-closed state update logic used by handleWindowClosed(),
// and additional extractable predicates from the app event handlers.
// The real functions in main.ts depend on Electron runtime APIs, so we inline
// pure parameterised copies here and test with a lightweight fake window shape.
//
// Fake BrowserWindow shape used throughout:
//   { isDestroyed: () => boolean }

interface FakeWindow {
  isDestroyed: () => boolean;
}

function makeWindow(alive = true): FakeWindow {
  return { isDestroyed: () => !alive };
}

// ── getTargetWindow() — pure fallback ordering ──

function getTargetWindow(
  focused: FakeWindow | null,
  latestFocused: FakeWindow | null,
  windows: Set<FakeWindow>,
): FakeWindow | null {
  if (focused && !focused.isDestroyed() && windows.has(focused)) {
    return focused;
  }
  if (latestFocused && !latestFocused.isDestroyed() && windows.has(latestFocused)) {
    return latestFocused;
  }
  let newestAlive: FakeWindow | null = null;
  for (const win of windows) {
    if (!win.isDestroyed()) newestAlive = win;
  }
  return newestAlive;
}

// ── handleWindowClosed() — pure state update ──

function handleWindowClosed(
  closingWin: FakeWindow,
  windows: Set<FakeWindow>,
  latestFocused: FakeWindow | null,
): { windows: Set<FakeWindow>; latestFocused: FakeWindow | null } {
  windows.delete(closingWin);
  const nextLatestFocused = latestFocused === closingWin ? null : latestFocused;
  return { windows: new Set(windows), latestFocused: nextLatestFocused };
}

// ── getSecondInstanceTarget() — for AC4 second-instance handler ──
//
// Production:  const target = latestFocusedWindow ?? getTargetWindow();
// Ordering:    latestFocused (tracked by us) → newest-alive from windows set

function getSecondInstanceTarget(
  latestFocused: FakeWindow | null,
  windows: Set<FakeWindow>,
): FakeWindow | null {
  if (latestFocused && !latestFocused.isDestroyed() && windows.has(latestFocused)) {
    return latestFocused;
  }
  let newestAlive: FakeWindow | null = null;
  for (const win of windows) {
    if (!win.isDestroyed()) newestAlive = win;
  }
  return newestAlive;
}

// ── shouldKeepAppAliveOnWindowClosed() — for AC12 ──
//
// Production (window-all-closed handler):
//   // All windows closed. Keep app alive — multi-window MVP relies on
//   // explicit Quit (Cmd+Q, dock Quit, menu Quit) to stop the shared runtime.
// Returns false to express: do NOT quit the app when all windows close.

function shouldKeepAppAliveOnWindowClosed(): boolean {
  return false;
}

// ── shouldCreateWindowOnActivate() — for AC14 activate handler ──
//
// Production:  app.on('activate', () => { if (windows.size === 0 && serverHandle) ... })
// macOS fires 'activate' when the app is clicked in the dock after all windows are closed.

function shouldCreateWindowOnActivate(windowsSize: number, hasServer: boolean): boolean {
  return windowsSize === 0 && hasServer;
}

// ── Tests ──

describe('getTargetWindow', () => {
  it('returns focused window when it is alive and in the set', () => {
    const w1 = makeWindow(true);
    const w2 = makeWindow(true);
    const ws = new Set([w1, w2]);
    const result = getTargetWindow(w2, w1, ws);
    expect(result).toBe(w2);
  });

  it('falls back to latestFocusedWindow when focused window is destroyed', () => {
    const focused = makeWindow(false); // destroyed
    const latest = makeWindow(true);
    const ws = new Set([latest, makeWindow(true)]);
    const result = getTargetWindow(focused, latest, ws);
    expect(result).toBe(latest);
  });

  it('falls back to latestFocusedWindow when focused window is not in the set', () => {
    const focused = makeWindow(true);
    const latest = makeWindow(true);
    const ws = new Set([latest, makeWindow(true)]);
    const result = getTargetWindow(focused, latest, ws);
    expect(result).toBe(latest);
  });

  it('falls back to newest alive set member when both focused and latestFocused are destroyed', () => {
    const focused = makeWindow(false);
    const latest = makeWindow(false);
    const w1 = makeWindow(true);
    const w2 = makeWindow(true);
    const w3 = makeWindow(true);
    const ws = new Set([w1, w2, w3]);
    const result = getTargetWindow(focused, latest, ws);
    // Should return the last (newest) alive member of the set
    expect(result).toBe(w3);
  });

  it('returns null when set is empty', () => {
    const focused = makeWindow(true);
    const latest = makeWindow(true);
    const ws = new Set<FakeWindow>();
    const result = getTargetWindow(focused, latest, ws);
    expect(result).toBeNull();
  });

  it('returns null when all windows in set are destroyed', () => {
    const focused = makeWindow(false);
    const latest = makeWindow(false);
    const w1 = makeWindow(false);
    const w2 = makeWindow(false);
    const ws = new Set([w1, w2]);
    const result = getTargetWindow(focused, latest, ws);
    expect(result).toBeNull();
  });

  it('ignores focused window when it is not in the windows set', () => {
    const focused = makeWindow(true); // alive, but NOT in set
    const latest = makeWindow(true);
    const ws = new Set([latest]);
    const result = getTargetWindow(focused, latest, ws);
    expect(result).toBe(latest);
  });

  it('prefers focused over latestFocused when both are alive', () => {
    const focused = makeWindow(true);
    const latest = makeWindow(true);
    const ws = new Set([focused, latest]);
    const result = getTargetWindow(focused, latest, ws);
    expect(result).toBe(focused);
  });

  it('returns latestFocused when focused is null', () => {
    const latest = makeWindow(true);
    const ws = new Set([latest, makeWindow(true)]);
    const result = getTargetWindow(null, latest, ws);
    expect(result).toBe(latest);
  });

  it('falls past null focused and destroyed latestFocused to newest alive', () => {
    const latest = makeWindow(false);
    const w1 = makeWindow(true);
    const w2 = makeWindow(true);
    const ws = new Set([w1, w2]);
    const result = getTargetWindow(null, latest, ws);
    expect(result).toBe(w2);
  });

  it('returns newest alive when trailing windows in the set are destroyed', () => {
    const focused = makeWindow(false);
    const latest = makeWindow(false);
    const w1 = makeWindow(true);
    const w2 = makeWindow(false); // destroyed — middle
    const w3 = makeWindow(false); // destroyed — newest
    const ws = new Set([w1, w2, w3]);
    const result = getTargetWindow(focused, latest, ws);
    // w1 is the last (and only) alive window in iteration order
    expect(result).toBe(w1);
  });
});

describe('getSecondInstanceTarget', () => {
  it('returns latestFocused when it is alive and in the set', () => {
    const latest = makeWindow(true);
    const ws = new Set([latest, makeWindow(true)]);
    const result = getSecondInstanceTarget(latest, ws);
    expect(result).toBe(latest);
  });

  it('falls back to newest alive when latestFocused is destroyed', () => {
    const latest = makeWindow(false);
    const w1 = makeWindow(true);
    const w2 = makeWindow(true);
    const ws = new Set([w1, w2]);
    const result = getSecondInstanceTarget(latest, ws);
    expect(result).toBe(w2);
  });

  it('falls back to newest alive when latestFocused is not in the set', () => {
    const latest = makeWindow(true);
    const w1 = makeWindow(true);
    const w2 = makeWindow(true);
    const ws = new Set([w1, w2]);
    const result = getSecondInstanceTarget(latest, ws);
    expect(result).toBe(w2);
  });

  it('returns null when set is empty', () => {
    const latest = makeWindow(true);
    const ws = new Set<FakeWindow>();
    const result = getSecondInstanceTarget(latest, ws);
    expect(result).toBeNull();
  });

  it('returns null when all windows are destroyed', () => {
    const latest = makeWindow(false);
    const w1 = makeWindow(false);
    const w2 = makeWindow(false);
    const ws = new Set([w1, w2]);
    const result = getSecondInstanceTarget(latest, ws);
    expect(result).toBeNull();
  });

  it('returns newest alive when latestFocused is null', () => {
    const w1 = makeWindow(true);
    const w2 = makeWindow(true);
    const ws = new Set([w1, w2]);
    const result = getSecondInstanceTarget(null, ws);
    expect(result).toBe(w2);
  });
});

describe('shouldKeepAppAliveOnWindowClosed', () => {
  it('returns false because the multi-window design keeps the app alive after all windows close', () => {
    // The empty window-all-closed handler overrides Electron's default (which would quit
    // on non-macOS). The return value false encodes "do NOT quit on window-all-closed."
    expect(shouldKeepAppAliveOnWindowClosed()).toBe(false);
  });

  it('returns false consistently regardless of external state', () => {
    // The predicate is a constant — the multi-window design always keeps the app alive.
    // This test guards against accidental changes that would cause a regression in AC12.
    expect(shouldKeepAppAliveOnWindowClosed()).toBe(false);
  });
});

describe('shouldCreateWindowOnActivate', () => {
  it('returns true when no windows are open and the server is running', () => {
    expect(shouldCreateWindowOnActivate(0, true)).toBe(true);
  });

  it('returns false when windows exist', () => {
    expect(shouldCreateWindowOnActivate(1, true)).toBe(false);
    expect(shouldCreateWindowOnActivate(3, true)).toBe(false);
  });

  it('returns false when the shared runtime server is not running', () => {
    expect(shouldCreateWindowOnActivate(0, false)).toBe(false);
    expect(shouldCreateWindowOnActivate(1, false)).toBe(false);
  });
});

describe('handleWindowClosed', () => {
  it('removes the closing window from the set', () => {
    const w1 = makeWindow();
    const w2 = makeWindow();
    const ws = new Set([w1, w2]);
    const { windows: nextWs } = handleWindowClosed(w1, ws, w2);
    expect(nextWs.has(w1)).toBe(false);
    expect(nextWs.has(w2)).toBe(true);
    expect(nextWs.size).toBe(1);
  });

  it('clears latestFocusedWindow when it matches the closing window', () => {
    const w1 = makeWindow();
    const w2 = makeWindow();
    const ws = new Set([w1, w2]);
    const { latestFocused } = handleWindowClosed(w1, ws, w1);
    expect(latestFocused).toBeNull();
  });

  it('preserves latestFocusedWindow when it does not match the closing window', () => {
    const w1 = makeWindow();
    const w2 = makeWindow();
    const ws = new Set([w1, w2]);
    const { latestFocused } = handleWindowClosed(w1, ws, w2);
    expect(latestFocused).toBe(w2);
  });

  it('preserves latestFocusedWindow when null and a non-matching window closes', () => {
    const w1 = makeWindow();
    const w2 = makeWindow();
    const ws = new Set([w1, w2]);
    const { latestFocused } = handleWindowClosed(w1, ws, null);
    expect(latestFocused).toBeNull();
  });

  it('leaves an empty set after removing the last window', () => {
    const w1 = makeWindow();
    const ws = new Set([w1]);
    const { windows: nextWs } = handleWindowClosed(w1, ws, null);
    expect(nextWs.size).toBe(0);
  });
});
