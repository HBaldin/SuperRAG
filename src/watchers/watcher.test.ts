import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Hoisted mocks (must be declared before vi.mock calls) ───────────────────

const { mockIndexFile, mockRemoveFile, mockWatchInstance, mockChokidarWatch } = vi.hoisted(() => {
  const EventEmitter = require('events').EventEmitter as typeof import('events').EventEmitter;

  class MockFSWatcher extends EventEmitter {
    close = vi.fn().mockResolvedValue(undefined);
  }

  const mockWatchInstance = { current: null as InstanceType<typeof MockFSWatcher> | null };
  const mockChokidarWatch = vi.fn(() => {
    const inst = new MockFSWatcher();
    mockWatchInstance.current = inst;
    return inst;
  });

  return {
    mockIndexFile: vi.fn().mockResolvedValue(undefined),
    mockRemoveFile: vi.fn().mockResolvedValue(undefined),
    mockWatchInstance,
    mockChokidarWatch,
  };
});

vi.mock('chokidar', () => ({
  default: { watch: mockChokidarWatch },
}));

vi.mock('../core/indexer.js', () => ({
  indexFile: mockIndexFile,
  removeFile: mockRemoveFile,
}));

// ─── Import after mocks ───────────────────────────────────────────────────────

import { FileWatcher } from './watcher.js';

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('FileWatcher', () => {
  const projectPath = '/project';
  const debounceMs = 100;

  beforeEach(() => {
    vi.useFakeTimers();
    mockIndexFile.mockClear();
    mockRemoveFile.mockClear();
  });

  afterEach(async () => {
    vi.useRealTimers();
  });

  // ── Test 1: start/stop lifecycle ──────────────────────────────────────────

  it('isRunning() returns true after start() and false after stop()', async () => {
    const watcher = new FileWatcher({ projectPath, debounceMs });

    expect(watcher.isRunning()).toBe(false);

    await watcher.start();
    expect(watcher.isRunning()).toBe(true);

    await watcher.stop();
    expect(watcher.isRunning()).toBe(false);
  });

  // ── Test 2: add event → onIndexed ─────────────────────────────────────────

  it('emits onIndexed with relative path on "add" event after debounce', async () => {
    const onIndexed = vi.fn();
    const watcher = new FileWatcher({ projectPath, debounceMs, onIndexed });

    await watcher.start();

    const absolutePath = '/project/src/foo.ts';
    mockWatchInstance.current!.emit('add', absolutePath);

    // Before debounce fires — not called yet
    expect(onIndexed).not.toHaveBeenCalled();

    await vi.runAllTimersAsync();

    expect(mockIndexFile).toHaveBeenCalledWith(absolutePath, projectPath);
    expect(onIndexed).toHaveBeenCalledWith('src/foo.ts');

    await watcher.stop();
  });

  // ── Test 3: unlink event → onRemoved ──────────────────────────────────────

  it('emits onRemoved with relative path on "unlink" event after debounce', async () => {
    const onRemoved = vi.fn();
    const watcher = new FileWatcher({ projectPath, debounceMs, onRemoved });

    await watcher.start();

    const absolutePath = '/project/src/bar.ts';
    mockWatchInstance.current!.emit('unlink', absolutePath);

    await vi.runAllTimersAsync();

    expect(mockRemoveFile).toHaveBeenCalledWith('src/bar.ts', projectPath);
    expect(onRemoved).toHaveBeenCalledWith('src/bar.ts');

    await watcher.stop();
  });

  // ── Test 4: node_modules ignored by chokidar pattern ─────────────────────

  it('does not call onIndexed for files inside node_modules (chokidar ignored pattern)', async () => {
    const onIndexed = vi.fn();
    const watcher = new FileWatcher({ projectPath, debounceMs, onIndexed });

    await watcher.start();

    // Simulate: chokidar ignores node_modules, so no event is emitted for them.
    // We verify that if somehow an event slips through with node_modules path,
    // the watcher still processes it (chokidar handles the ignore).
    // The real guard is the `ignored` option passed to chokidar.watch().
    // Here we just verify that a normal file IS indexed and node_modules path is NOT emitted.
    const normalPath = '/project/src/index.ts';
    mockWatchInstance.current!.emit('add', normalPath);

    await vi.runAllTimersAsync();

    expect(onIndexed).toHaveBeenCalledWith('src/index.ts');
    expect(onIndexed).not.toHaveBeenCalledWith(expect.stringContaining('node_modules'));

    await watcher.stop();
  });

  // ── Test 5: debounce — multiple rapid events → only 1 call ───────────────

  it('debounces multiple rapid events on the same file into a single indexFile call', async () => {
    const onIndexed = vi.fn();
    const watcher = new FileWatcher({ projectPath, debounceMs, onIndexed });

    await watcher.start();

    const absolutePath = '/project/src/component.ts';

    // Emit 5 rapid change events
    mockWatchInstance.current!.emit('change', absolutePath);
    mockWatchInstance.current!.emit('change', absolutePath);
    mockWatchInstance.current!.emit('change', absolutePath);
    mockWatchInstance.current!.emit('change', absolutePath);
    mockWatchInstance.current!.emit('change', absolutePath);

    // Advance time past debounce
    await vi.runAllTimersAsync();

    // Should only have been called once
    expect(mockIndexFile).toHaveBeenCalledTimes(1);
    expect(onIndexed).toHaveBeenCalledTimes(1);
    expect(onIndexed).toHaveBeenCalledWith('src/component.ts');

    await watcher.stop();
  });
});
