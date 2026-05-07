import { getConfig } from '../config/index.js';
import { getLogger } from '../utils/logger.js';
import type { EmbeddingResponse } from '../types/index.js';

const logger = getLogger('embedding-client');

export class EmbeddingClient {
  private baseUrl: string;
  private timeoutMs: number;
  private maxRetries: number;

  constructor() {
    const config = getConfig().embedding;
    this.baseUrl = config.serverUrl;
    this.timeoutMs = config.timeoutMs;
    this.maxRetries = config.maxRetries;
  }

  async embed(text: string): Promise<number[]> {
    const result = await this.embedBatch([text]);
    return result.embeddings[0]!;
  }

  async embedBatch(texts: string[]): Promise<EmbeddingResponse> {
    if (texts.length === 0) {
      return { embeddings: [], model: '', dimensions: 0, durationMs: 0 };
    }

    const config = getConfig().embedding;
    const batches = this.splitIntoBatches(texts, config.batchSize);
    const allEmbeddings: number[][] = [];
    let totalDuration = 0;
    let model = '';
    let dimensions = 0;

    for (const batch of batches) {
      const result = await this.fetchWithRetry<{
        embeddings: number[][];
        model: string;
        dimensions: number;
        duration_ms: number;
      }>('/embed-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ texts: batch }),
      });

      allEmbeddings.push(...result.embeddings);
      totalDuration += result.duration_ms;
      model = result.model;
      dimensions = result.dimensions;
    }

    return {
      embeddings: allEmbeddings,
      model,
      dimensions,
      durationMs: totalDuration,
    };
  }

  async health(): Promise<{ status: string; device: string; dimensions: number }> {
    return this.fetchWithRetry('/health', { method: 'GET' });
  }

  async isAvailable(): Promise<boolean> {
    try {
      const h = await this.health();
      return h.status === 'ok';
    } catch {
      return false;
    }
  }

  splitIntoBatches(texts: string[], batchSize: number): string[][] {
    const batches: string[][] = [];
    for (let i = 0; i < texts.length; i += batchSize) {
      batches.push(texts.slice(i, i + batchSize));
    }
    return batches;
  }

  private async fetchWithRetry<T>(path: string, init: RequestInit): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);

        const response = await fetch(`${this.baseUrl}${path}`, {
          ...init,
          signal: controller.signal,
        });

        clearTimeout(timer);

        if (!response.ok) {
          const body = await response.text();
          throw new Error(`HTTP ${response.status}: ${body}`);
        }

        return await response.json() as T;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < this.maxRetries) {
          const delay = Math.pow(2, attempt) * 200;
          logger.warn({ attempt, path, delay }, 'Embedding request failed, retrying');
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }

    throw lastError ?? new Error('Embedding request failed');
  }
}

// Singleton
let _client: EmbeddingClient | null = null;

export function getEmbeddingClient(): EmbeddingClient {
  if (!_client) _client = new EmbeddingClient();
  return _client;
}
