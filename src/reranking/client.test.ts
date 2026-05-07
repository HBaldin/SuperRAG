import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RerankClient } from './client.js';

vi.mock('../config/index.js', () => ({
  getConfig: () => ({
    rerank: {
      serverUrl: 'http://localhost:8002',
      model: 'BAAI/bge-reranker-v2-m3',
      topK: 10,
      timeoutMs: 5000,
      maxRetries: 0,
      enabled: true,
    },
    logging: { level: 'error', pretty: false, traceEnabled: false },
  }),
}));

describe('RerankClient', () => {
  it('should return empty scores for empty documents', async () => {
    const client = new RerankClient();
    const result = await client.rerank('query', []);
    expect(result.scores).toHaveLength(0);
  });

  it('should return false for isAvailable when server is down', async () => {
    const client = new RerankClient();
    const available = await client.isAvailable();
    expect(available).toBe(false);
  });

  it('should call /rerank endpoint with correct payload', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        scores: [{ index: 0, score: 0.95 }, { index: 1, score: 0.7 }],
        model: 'BAAI/bge-reranker-v2-m3',
        duration_ms: 50,
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const client = new RerankClient();
    const result = await client.rerank('find auth', ['jwt validation', 'database query'], 2);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/rerank');
    const body = JSON.parse(opts.body as string) as { query: string; documents: string[] };
    expect(body.query).toBe('find auth');
    expect(body.documents).toHaveLength(2);
    expect(result.scores).toHaveLength(2);
    expect(result.scores[0]!.score).toBe(0.95);

    vi.unstubAllGlobals();
  });
});
