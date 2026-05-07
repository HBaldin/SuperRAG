import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync, mkdirSync } from 'fs';

// Override config to use temp DB
import { vi } from 'vitest';

vi.mock('../config/index.js', () => ({
  getConfig: () => ({
    sqlite: {
      path: '/tmp/superrag-test-sqlite/test.db',
      walMode: true,
      cacheSize: -1000,
    },
    logging: { level: 'error', pretty: false, traceEnabled: false },
  }),
}));

import {
  getDb,
  closeDb,
  upsertFingerprint,
  getAllFingerprints,
  deleteFingerprint,
  upsertChunks,
  searchFts,
  upsertFileSummary,
  getStorageStats,
} from './sqlite.js';
import type { FileFingerprint, Chunk, FileSummary } from '../types/index.js';

const TEST_DIR = '/tmp/superrag-test-sqlite';

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  closeDb();
  rmSync(TEST_DIR, { recursive: true, force: true });
});

function makeFingerprint(path: string): FileFingerprint {
  return {
    path,
    absolutePath: `/abs/${path}`,
    hash: 'abc123',
    modifiedTime: Date.now(),
    size: 100,
    encoding: 'utf-8',
    mimeType: 'text/plain',
    isBinary: false,
  };
}

function makeChunk(id: string, docId: string): Chunk {
  return {
    id,
    parentId: null,
    documentId: docId,
    path: '/tmp/test.ts',
    relativePath: 'src/test.ts',
    kind: 'function',
    language: 'typescript',
    title: 'function: testFn',
    content: 'function testFn() { return 42; }',
    summary: 'A test function',
    tags: ['typescript', 'function'],
    dependencies: [],
    references: [],
    tokenEstimate: 10,
    startLine: 1,
    endLine: 3,
    embeddingRef: null,
    metadata: { domain: 'backend', complexity: 'low', isPublicApi: true },
  };
}

describe('SQLite fingerprints', () => {
  it('should upsert and retrieve fingerprints', () => {
    upsertFingerprint(makeFingerprint('src/index.ts'));
    upsertFingerprint(makeFingerprint('src/utils.ts'));
    const map = getAllFingerprints();
    expect(map.size).toBe(2);
    expect(map.has('src/index.ts')).toBe(true);
  });

  it('should delete fingerprint', () => {
    upsertFingerprint(makeFingerprint('src/index.ts'));
    deleteFingerprint('src/index.ts');
    const map = getAllFingerprints();
    expect(map.has('src/index.ts')).toBe(false);
  });
});

describe('SQLite chunks + FTS', () => {
  it('should upsert chunks and search via FTS', () => {
    const chunk = makeChunk('chunk_001', 'doc_001');
    upsertChunks([{ chunk, content: 'function testFn returns the answer to everything' }]);

    const results = searchFts('testFn');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.chunkId).toBe('chunk_001');
  });

  it('should return empty for no match', () => {
    const results = searchFts('xyznonexistent');
    expect(results).toHaveLength(0);
  });
});

describe('SQLite stats', () => {
  it('should return correct counts', () => {
    upsertFingerprint(makeFingerprint('src/a.ts'));
    const chunk = makeChunk('chunk_001', 'doc_001');
    upsertChunks([{ chunk, content: 'some content here' }]);

    const stats = getStorageStats();
    expect(stats.fingerprints).toBe(1);
    expect(stats.chunks).toBe(1);
  });
});
