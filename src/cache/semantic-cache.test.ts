import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { resolve } from 'path';
import { SemanticCache } from './semantic-cache.js';
import type { QueryResult } from '../types/index.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const TEST_DB_PATH = '/tmp/opencode/test-semantic-cache.db';

// Synthetic embeddings for controlled similarity
const embeddingA = [1, 0, 0, 0];
const embeddingB = [1, 0, 0, 0]; // identical → similarity = 1.0
const embeddingOrthogonal = [0, 1, 0, 0]; // orthogonal → similarity = 0.0

function makeResult(query: string): QueryResult {
  return {
    query,
    rewrittenQuery: query,
    intent: 'general',
    chunks: [],
    summaries: {},
    relations: [],
    metadata: {
      totalTimeMs: 10,
      parseTimeMs: 0,
      vectorTimeMs: 5,
      ftsTimeMs: 3,
      rerankTimeMs: 1,
      compressionTimeMs: 1,
      cacheHit: false,
      candidatesBeforeRerank: 0,
      tokensBeforeCompression: 0,
      tokensAfterCompression: 0,
      tokensSaved: 0,
    },
  };
}

// ─── Mock config ──────────────────────────────────────────────────────────────

vi.mock('../config/index.js', () => ({
  getConfig: () => ({
    cache: {
      semanticCacheEnabled: true,
      semanticSimilarityThreshold: 0.92,
      queryCacheTtlSeconds: 3600,
      maxCacheEntries: 5,
      persistPath: '/tmp/opencode/test-semantic-cache.db',
    },
    logging: {
      level: 'error',
      pretty: false,
      traceEnabled: false,
    },
  }),
}));

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SemanticCache', () => {
  let cache: SemanticCache;

  beforeEach(() => {
    mkdirSync('/tmp/opencode', { recursive: true });
    // Remove DB before each test for isolation
    if (existsSync(TEST_DB_PATH)) rmSync(TEST_DB_PATH);
    if (existsSync(TEST_DB_PATH + '-wal')) rmSync(TEST_DB_PATH + '-wal');
    if (existsSync(TEST_DB_PATH + '-shm')) rmSync(TEST_DB_PATH + '-shm');
    cache = new SemanticCache();
  });

  afterEach(() => {
    cache.close();
  });

  it('set() + get() with identical query → cache hit (similarity = 1.0)', async () => {
    const result = makeResult('how to implement auth');
    await cache.set('how to implement auth', embeddingA, result);

    const hit = await cache.get('how to implement auth', embeddingB);
    expect(hit).not.toBeNull();
    expect(hit?.query).toBe('how to implement auth');
  });

  it('get() with orthogonal embedding → null (below threshold)', async () => {
    const result = makeResult('how to implement auth');
    await cache.set('how to implement auth', embeddingA, result);

    const miss = await cache.get('different query', embeddingOrthogonal);
    expect(miss).toBeNull();
  });

  it('get() with expired entry → null', async () => {
    const result = makeResult('expired query');

    // Manually insert an already-expired entry
    // We need to access the db — use a workaround via set then manually expire
    await cache.set('expired query', embeddingA, result);

    // Directly manipulate the DB to set expires_at in the past
    // Access via a fresh DB connection
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(TEST_DB_PATH);
    db.prepare("UPDATE query_cache SET expires_at = 1 WHERE query_text = 'expired query'").run();
    db.close();

    // Clear mem cache by creating a new instance
    cache.close();
    cache = new SemanticCache();

    const miss = await cache.get('expired query', embeddingA);
    expect(miss).toBeNull();
  });

  it('clear() → get returns null', async () => {
    const result = makeResult('some query');
    await cache.set('some query', embeddingA, result);

    await cache.clear();

    const miss = await cache.get('some query', embeddingA);
    expect(miss).toBeNull();
  });

  it('eviction — inserting maxCacheEntries+1 does not exceed limit', async () => {
    // maxCacheEntries = 5 in mock config
    for (let i = 0; i < 6; i++) {
      await cache.set(`query ${i}`, embeddingA, makeResult(`query ${i}`));
    }

    const stats = cache.getStats();
    expect(stats.size).toBeLessThanOrEqual(5);
  });

  it('persistence — create, insert, close, reopen → entry present', async () => {
    const result = makeResult('persistent query');
    await cache.set('persistent query', embeddingA, result);
    cache.close();

    // Reopen
    cache = new SemanticCache();
    const hit = await cache.get('persistent query', embeddingB);
    expect(hit).not.toBeNull();
    expect(hit?.query).toBe('persistent query');
  });
});
