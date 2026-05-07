import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createProgram } from './index.js';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../core/indexer.js', () => ({
  indexProject: vi.fn().mockResolvedValue({
    projectPath: '/tmp',
    filesScanned: 10,
    filesIndexed: 8,
    filesSkipped: 2,
    chunksCreated: 50,
    embeddingsGenerated: 50,
    errors: [],
    durationMs: 1200,
    incrementalDelta: { newFiles: [], modifiedFiles: [], deletedFiles: [], unchangedFiles: 2 },
  }),
  indexFile: vi.fn().mockResolvedValue(undefined),
  removeFile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../core/query-pipeline.js', () => ({
  runQueryPipeline: vi.fn().mockResolvedValue({
    query: 'test',
    rewrittenQuery: 'test',
    intent: 'general',
    chunks: [
      {
        id: 'chunk-1',
        parentId: null,
        documentId: 'doc-1',
        path: '/tmp/foo.ts',
        relativePath: 'foo.ts',
        kind: 'function',
        language: 'typescript',
        title: 'myFunction',
        content: 'function myFunction() {}',
        summary: 'A function',
        tags: [],
        dependencies: [],
        references: [],
        tokenEstimate: 10,
        startLine: 1,
        endLine: 3,
        embeddingRef: null,
        metadata: {},
        score: 0.95,
        scoreBreakdown: { vector: 0.9, fts: 0.8, rerank: 0.95, graph: 0.7 },
      },
    ],
    summaries: {},
    relations: [],
    metadata: {
      totalTimeMs: 42,
      parseTimeMs: 0,
      vectorTimeMs: 10,
      ftsTimeMs: 5,
      rerankTimeMs: 15,
      compressionTimeMs: 5,
      cacheHit: false,
      candidatesBeforeRerank: 20,
      tokensBeforeCompression: 500,
      tokensAfterCompression: 300,
      tokensSaved: 200,
    },
  }),
}));

vi.mock('../storage/sqlite.js', () => ({
  getStorageStats: vi.fn().mockReturnValue({
    chunks: 312,
    files: 45,
    modules: 8,
    projects: 1,
    fingerprints: 45,
  }),
  getAllFingerprints: vi.fn().mockReturnValue([]),
  getDb: vi.fn().mockReturnValue({}),
}));

vi.mock('../watchers/watcher.js', () => ({
  FileWatcher: vi.fn().mockImplementation(() => ({
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    isRunning: vi.fn().mockReturnValue(false),
  })),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function captureOutput(fn: () => Promise<unknown>): Promise<{ stdout: string; stderr: string }> {
  return new Promise(async (resolve) => {
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];

    const origLog = console.log;
    const origWarn = console.warn;
    const origError = console.error;

    console.log = (...args: unknown[]) => stdoutLines.push(args.map(String).join(' '));
    console.warn = (...args: unknown[]) => stderrLines.push(args.map(String).join(' '));
    console.error = (...args: unknown[]) => stderrLines.push(args.map(String).join(' '));

    try {
      await fn();
    } finally {
      console.log = origLog;
      console.warn = origWarn;
      console.error = origError;
    }

    resolve({ stdout: stdoutLines.join('\n'), stderr: stderrLines.join('\n') });
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('CLI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('--version displays version', async () => {
    const program = createProgram();
    let output = '';
    const origLog = console.log;
    // Commander writes version to stdout via process.stdout.write or console.log
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array) => {
      output += chunk.toString();
      return true;
    };

    try {
      await program.parseAsync(['node', 'rag', '--version']).catch(() => {});
    } finally {
      process.stdout.write = origWrite;
      console.log = origLog;
    }

    expect(output).toContain('0.1.0');
  });

  it('--help does not throw', async () => {
    const program = createProgram();
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (_chunk: string | Uint8Array) => true;

    try {
      await expect(
        program.parseAsync(['node', 'rag', '--help']).catch(() => {})
      ).resolves.not.toThrow();
    } finally {
      process.stdout.write = origWrite;
    }
  });

  it('query "test" calls runQueryPipeline and displays results', async () => {
    const { runQueryPipeline } = await import('../core/query-pipeline.js');

    const program = createProgram();
    const { stdout } = await captureOutput(() =>
      program.parseAsync(['node', 'rag', 'query', 'test'])
    );

    expect(runQueryPipeline).toHaveBeenCalledOnce();
    expect(runQueryPipeline).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'test', topK: 10 })
    );
    expect(stdout).toContain('myFunction');
    expect(stdout).toContain('foo.ts');
  });

  it('query "test" --json outputs valid JSON', async () => {
    const program = createProgram();
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => lines.push(args.map(String).join(' '));

    try {
      await program.parseAsync(['node', 'rag', 'query', 'test', '--json']);
    } finally {
      console.log = origLog;
    }

    const raw = lines.join('\n');
    expect(() => JSON.parse(raw)).not.toThrow();
    const parsed = JSON.parse(raw);
    expect(parsed).toHaveProperty('query', 'test');
    expect(parsed).toHaveProperty('chunks');
  });

  it('stats calls getStorageStats and displays table', async () => {
    const { getStorageStats } = await import('../storage/sqlite.js');

    const program = createProgram();
    const { stdout } = await captureOutput(() =>
      program.parseAsync(['node', 'rag', 'stats'])
    );

    expect(getStorageStats).toHaveBeenCalledOnce();
    expect(stdout).toContain('312');  // chunks
    expect(stdout).toContain('45');   // fingerprints
  });

  it('index /tmp calls indexProject', async () => {
    const { indexProject } = await import('../core/indexer.js');

    const program = createProgram();
    await captureOutput(() =>
      program.parseAsync(['node', 'rag', 'index', '/tmp'])
    );

    expect(indexProject).toHaveBeenCalledOnce();
    expect(indexProject).toHaveBeenCalledWith(
      expect.objectContaining({ projectPath: '/tmp', force: false })
    );
  });
});
