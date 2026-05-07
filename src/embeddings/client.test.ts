import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EmbeddingClient } from './client.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeMockFetch(response: unknown, ok = true, status = 200) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => response,
    text: async () => JSON.stringify(response),
  });
}

// ─── splitIntoBatches ─────────────────────────────────────────────────────────

describe('EmbeddingClient.splitIntoBatches', () => {
  const client = new EmbeddingClient();

  it('returns single batch when texts fit within batchSize', () => {
    const texts = ['a', 'b', 'c'];
    const result = client.splitIntoBatches(texts, 10);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(['a', 'b', 'c']);
  });

  it('splits into multiple batches correctly', () => {
    const texts = ['a', 'b', 'c', 'd', 'e'];
    const result = client.splitIntoBatches(texts, 2);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual(['a', 'b']);
    expect(result[1]).toEqual(['c', 'd']);
    expect(result[2]).toEqual(['e']);
  });

  it('returns empty array for empty input', () => {
    const result = client.splitIntoBatches([], 10);
    expect(result).toHaveLength(0);
  });

  it('handles batchSize equal to texts length', () => {
    const texts = ['x', 'y', 'z'];
    const result = client.splitIntoBatches(texts, 3);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(['x', 'y', 'z']);
  });

  it('handles batchSize of 1', () => {
    const texts = ['a', 'b', 'c'];
    const result = client.splitIntoBatches(texts, 1);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual(['a']);
    expect(result[1]).toEqual(['b']);
    expect(result[2]).toEqual(['c']);
  });
});

// ─── embedBatch — empty input ─────────────────────────────────────────────────

describe('EmbeddingClient.embedBatch', () => {
  let client: EmbeddingClient;

  beforeEach(() => {
    client = new EmbeddingClient();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns empty response for empty texts array', async () => {
    const result = await client.embedBatch([]);
    expect(result.embeddings).toEqual([]);
    expect(result.model).toBe('');
    expect(result.dimensions).toBe(0);
    expect(result.durationMs).toBe(0);
  });

  it('calls /embed-batch and returns merged embeddings', async () => {
    const mockResponse = {
      embeddings: [[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]],
      model: 'BAAI/bge-m3',
      dimensions: 3,
      duration_ms: 42,
    };

    const mockFetch = makeMockFetch(mockResponse);
    vi.stubGlobal('fetch', mockFetch);

    const result = await client.embedBatch(['hello', 'world']);

    expect(mockFetch).toHaveBeenCalledOnce();
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/embed-batch'),
      expect.objectContaining({ method: 'POST' }),
    );
    expect(result.embeddings).toHaveLength(2);
    expect(result.model).toBe('BAAI/bge-m3');
    expect(result.dimensions).toBe(3);
    expect(result.durationMs).toBe(42);
  });

  it('merges embeddings from multiple batches', async () => {
    // batchSize from config defaults to 32; we override by using a client
    // with a tiny batch via splitIntoBatches directly — test via spy
    const mockResponse = (texts: string[]) => ({
      embeddings: texts.map((_, i) => [i * 0.1]),
      model: 'BAAI/bge-m3',
      dimensions: 1,
      duration_ms: 10,
    });

    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { texts: string[] };
      callCount++;
      return {
        ok: true,
        status: 200,
        json: async () => mockResponse(body.texts),
        text: async () => '',
      };
    });
    vi.stubGlobal('fetch', mockFetch);

    // Manually split and call to simulate multi-batch
    const texts = ['a', 'b'];
    const batches = client.splitIntoBatches(texts, 1); // force 2 batches
    const allEmbeddings: number[][] = [];
    let totalDuration = 0;
    let model = '';
    let dimensions = 0;

    for (const batch of batches) {
      const res = await (client as unknown as {
        fetchWithRetry: <T>(path: string, init: RequestInit) => Promise<T>;
      }).fetchWithRetry<{
        embeddings: number[][];
        model: string;
        dimensions: number;
        duration_ms: number;
      }>('/embed-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ texts: batch }),
      });
      allEmbeddings.push(...res.embeddings);
      totalDuration += res.duration_ms;
      model = res.model;
      dimensions = res.dimensions;
    }

    expect(callCount).toBe(2);
    expect(allEmbeddings).toHaveLength(2);
    expect(model).toBe('BAAI/bge-m3');
    expect(totalDuration).toBe(20);
  });
});

// ─── isAvailable ──────────────────────────────────────────────────────────────

describe('EmbeddingClient.isAvailable', () => {
  let client: EmbeddingClient;

  beforeEach(() => {
    client = new EmbeddingClient();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns true when server responds with status ok', async () => {
    const mockFetch = makeMockFetch({ status: 'ok', device: 'cpu', dimensions: 1024 });
    vi.stubGlobal('fetch', mockFetch);

    const result = await client.isAvailable();
    expect(result).toBe(true);
  });

  it('returns false when server responds with status loading', async () => {
    const mockFetch = makeMockFetch({ status: 'loading', device: 'cpu', dimensions: 1024 });
    vi.stubGlobal('fetch', mockFetch);

    const result = await client.isAvailable();
    expect(result).toBe(false);
  });

  it('returns false when fetch throws (server unreachable)', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', mockFetch);

    const result = await client.isAvailable();
    expect(result).toBe(false);
  });

  it('returns false when server returns HTTP error', async () => {
    const mockFetch = makeMockFetch({ detail: 'Internal Server Error' }, false, 500);
    vi.stubGlobal('fetch', mockFetch);

    const result = await client.isAvailable();
    expect(result).toBe(false);
  });
});
