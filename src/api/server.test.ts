import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildServer } from './server.js';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../core/indexer.js', () => ({
  indexProject: vi.fn().mockResolvedValue({
    projectPath: '/tmp/test',
    filesScanned: 10,
    filesIndexed: 8,
    filesSkipped: 2,
    chunksCreated: 40,
    embeddingsGenerated: 40,
    errors: [],
    durationMs: 500,
    incrementalDelta: {
      newFiles: [],
      modifiedFiles: [],
      deletedFiles: [],
      unchangedFiles: 2,
    },
  }),
}));

vi.mock('../core/query-pipeline.js', () => ({
  runQueryPipeline: vi.fn().mockResolvedValue({
    query: 'test',
    rewrittenQuery: 'test',
    intent: 'general',
    chunks: [],
    summaries: {},
    relations: [],
    metadata: {
      totalTimeMs: 10,
      parseTimeMs: 0,
      vectorTimeMs: 5,
      ftsTimeMs: 3,
      rerankTimeMs: 2,
      compressionTimeMs: 0,
      cacheHit: false,
      candidatesBeforeRerank: 0,
      tokensBeforeCompression: 0,
      tokensAfterCompression: 0,
      tokensSaved: 0,
    },
  }),
}));

vi.mock('../storage/sqlite.js', () => ({
  getStorageStats: vi.fn().mockReturnValue({
    chunks: 100,
    files: 10,
    modules: 3,
    projects: 1,
    fingerprints: 10,
  }),
  getAllFingerprints: vi.fn().mockReturnValue(new Map()),
  deleteChunksByDocument: vi.fn(),
  deleteFingerprint: vi.fn(),
  getDb: vi.fn().mockReturnValue({}),
}));

vi.mock('../storage/qdrant.js', () => ({
  deleteChunksByPath: vi.fn().mockResolvedValue(undefined),
  ensureCollections: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../graph/graph.js', () => ({
  deleteNodesByPath: vi.fn(),
  initGraphSchema: vi.fn(),
}));

vi.mock('../adapters/agent-adapter.js', () => ({
  queryAndBuildContext: vi.fn().mockResolvedValue({
    query: 'test',
    summaries: {},
    chunks: [],
    relations: [],
    metadata: {
      totalTimeMs: 10,
      parseTimeMs: 0,
      vectorTimeMs: 5,
      ftsTimeMs: 3,
      rerankTimeMs: 2,
      compressionTimeMs: 0,
      cacheHit: false,
      candidatesBeforeRerank: 0,
      tokensBeforeCompression: 0,
      tokensAfterCompression: 0,
      tokensSaved: 0,
      projectPath: '/tmp',
      indexedAt: new Date().toISOString(),
    },
  }),
}));

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SuperRAG API Server', () => {
  let app: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    app = await buildServer();
  });

  // 1. GET /health → 200 { status: 'ok' }
  it('GET /health returns 200 with status ok', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ status: string }>();
    expect(body.status).toBe('ok');
    expect(body).toHaveProperty('timestamp');
    expect(body).toHaveProperty('uptime');
  });

  // 2. POST /query sem body → 400
  it('POST /query without body returns 400', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/query',
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    const body = response.json<{ statusCode: number }>();
    expect(body.statusCode).toBe(400);
  });

  // 3. POST /query com body válido → 200 com QueryResult
  it('POST /query with valid body returns 200 with QueryResult', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/query',
      payload: { query: 'test', projectPath: '/tmp' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ query: string; intent: string }>();
    expect(body).toHaveProperty('query');
    expect(body).toHaveProperty('intent');
    expect(body).toHaveProperty('chunks');
  });

  // 4. POST /index sem projectPath → 400
  it('POST /index without projectPath returns 400', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/index',
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    const body = response.json<{ statusCode: number }>();
    expect(body.statusCode).toBe(400);
  });

  // 5. POST /index com projectPath válido → 200 com IndexingResult
  it('POST /index with valid projectPath returns 200 with IndexingResult', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/index',
      payload: { projectPath: '/tmp/test' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ projectPath: string; filesScanned: number }>();
    expect(body).toHaveProperty('projectPath');
    expect(body).toHaveProperty('filesScanned');
    expect(body).toHaveProperty('chunksCreated');
  });

  // 6. GET /stats → 200
  it('GET /stats returns 200 with storage stats', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/stats',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ chunks: number }>();
    expect(body).toHaveProperty('chunks');
    expect(body).toHaveProperty('files');
    expect(body).toHaveProperty('fingerprints');
  });

  // 7. Rota inexistente → 404
  it('Unknown route returns 404', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/nonexistent-route',
    });

    expect(response.statusCode).toBe(404);
    const body = response.json<{ error: string; statusCode: number }>();
    expect(body.error).toBe('Not found');
    expect(body.statusCode).toBe(404);
  });
});
