import { getConfig } from '../config/index.js';
import { getLogger } from '../utils/logger.js';
import type { RerankRequest, RerankResponse } from '../types/index.js';

const logger = getLogger('rerank-client');

export class RerankClient {
  private baseUrl: string;
  private timeoutMs: number;
  private maxRetries: number;

  constructor() {
    const config = getConfig().rerank;
    this.baseUrl = config.serverUrl;
    this.timeoutMs = config.timeoutMs;
    this.maxRetries = config.maxRetries;
  }

  async rerank(query: string, documents: string[], topK?: number): Promise<RerankResponse> {
    if (documents.length === 0) {
      return { scores: [], model: '', durationMs: 0 };
    }

    const result = await this.fetchWithRetry<{
      scores: Array<{ index: number; score: number }>;
      model: string;
      duration_ms: number;
    }>('/rerank', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        documents,
        top_k: topK ?? getConfig().rerank.topK,
      }),
    });

    return {
      scores: result.scores,
      model: result.model,
      durationMs: result.duration_ms,
    };
  }

  async isAvailable(): Promise<boolean> {
    try {
      const h = await this.fetchWithRetry<{ status: string }>('/health', { method: 'GET' });
      return h.status === 'ok';
    } catch {
      return false;
    }
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
          logger.warn({ attempt, path, delay }, 'Rerank request failed, retrying');
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }

    throw lastError ?? new Error('Rerank request failed');
  }
}

let _client: RerankClient | null = null;

export function getRerankClient(): RerankClient {
  if (!_client) _client = new RerankClient();
  return _client;
}
